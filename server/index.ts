/**
 * ZCode Token 用量仪表盘 — 本地服务
 * 路由：/api/snapshot、/api/events(SSE)、/api/providers、/api/settings、/api/export、静态 web/
 * 每 2 秒重算聚合，有变化才通过 SSE 推送。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveDbPath,
  getDaily,
  getTrend,
  getModelTotals,
  getTodayByModel,
  getOverview,
  getDetailSince,
  type ModelUsageRow,
} from './db.ts';
import { buildProviderList } from './providers.ts';
import { loadSettings, saveSettings, normalizeSettings } from './settings.ts';
import { publishSafe } from './publish.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 5323);
const HOST = process.env.HOST || '127.0.0.1';

interface Snapshot {
  generatedAt: number;
  meta: { dbPath: string; error?: string };
  overview?: ReturnType<typeof getOverview>;
  daily?: ReturnType<typeof getDaily>;
  trend7?: ReturnType<typeof getTrend>;
  trend30?: ReturnType<typeof getTrend>;
  modelTotals?: ModelUsageRow[];
  today?: ModelUsageRow[];
}

function buildSnapshot(): Snapshot {
  const meta: Snapshot['meta'] = { dbPath: resolveDbPath() };
  try {
    const daily = getDaily();
    return {
      generatedAt: Date.now(),
      meta,
      overview: getOverview(daily),
      daily,
      trend7: getTrend(7),
      trend30: getTrend(30),
      modelTotals: getModelTotals(),
      today: getTodayByModel(),
    };
  } catch (e) {
    return { generatedAt: Date.now(), meta: { ...meta, error: String((e as Error).message ?? e) } };
  }
}

// ---------- SSE ----------
const sseClients = new Set<http.ServerResponse>();
let lastSnapObj: Snapshot = buildSnapshot();
let lastSnapJson = '';

function broadcast(json: string): void {
  for (const res of sseClients) {
    try {
      res.write(`event: snapshot\ndata: ${json}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function refresh(): void {
  const snap = buildSnapshot();
  const json = JSON.stringify(snap);
  if (json !== lastSnapJson) {
    lastSnapObj = snap;
    lastSnapJson = json;
    if (sseClients.size) broadcast(json);
  }
}

setInterval(refresh, 2000);
refresh();

// 自动发布快照到 GitCode Pages（settings.publish 控制，默认每 5 分钟）
let lastPublishAt = 0;
setTimeout(publishSafe, 5000);
setInterval(() => {
  try {
    const cfg = loadSettings().publish;
    if (!cfg?.enabled) return;
    if (Date.now() - lastPublishAt < cfg.intervalMin * 60000) return;
    lastPublishAt = Date.now();
    publishSafe();
  } catch {
    /* 发布失败不影响本地服务 */
  }
}, 30000);
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000);

// ---------- HTTP ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res: http.ServerResponse, code: number, body: string, type = 'application/json; charset=utf-8'): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res: http.ServerResponse, code: number, obj: unknown): void {
  send(res, code, JSON.stringify(obj));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > 262144) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = path.normalize(rel).replace(/^([/\\]|\.\.)+/, '');
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const cache = rel.startsWith('vendor/') ? 'public, max-age=86400' : 'no-store';
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cache });
  res.end(fs.readFileSync(file));
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(days: number): string {
  const rows = getDetailSince(days);
  const { prices } = loadSettings();
  const lines = ['日期,供应商,模型,请求数,输入Tokens,输出Tokens,缓存读Tokens,缓存写Tokens,总量Tokens,估算成本(元)'];
  for (const r of rows) {
    const total = r.si + r.so;
    const price = prices[`${r.provider}|${r.model}`];
    const cost = price ? ((price.in * r.si + price.out * r.so) / 1e6).toFixed(4) : '';
    lines.push(
      [r.d, r.provider, r.model, r.req, r.si, r.so, r.cr, r.cw, total, cost].map(csvEscape).join(',')
    );
  }
  return '\ufeff' + lines.join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/snapshot') {
      if (!lastSnapObj) refresh();
      json(res, 200, lastSnapObj);
      return;
    }
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${lastSnapJson || JSON.stringify(lastSnapObj)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/providers') {
      json(res, 200, {
        providers: buildProviderList(loadSettings(), lastSnapObj?.modelTotals ?? getModelTotals()),
      });
      return;
    }
    if (p === '/api/settings') {
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const s = normalizeSettings(JSON.parse(body || '{}'));
        saveSettings(s);
        refresh();
        json(res, 200, { ok: true });
      } else {
        json(res, 200, loadSettings());
      }
      return;
    }
    if (p === '/api/export') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') || 30)));
      const csv = exportCsv(days);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="zcode-usage-${days}d.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv);
      return;
    }
    if (p === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (p.startsWith('/api/')) {
      json(res, 404, { error: 'unknown api' });
      return;
    }
    serveStatic(res, p);
  } catch (e) {
    json(res, 500, { error: String((e as Error).message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ZCode Token 用量仪表盘已启动');
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  数据源（只读）：${resolveDbPath()}`);
  console.log('');
});
