/**
 * 静态站点发布器：构建 dist/（前端 + data.json 快照 + usage.csv）并推送到 GitCode 的 pages 分支。
 * GitCode Pages 只能托管静态文件、读不到本机 SQLite，因此由本地定时推送快照实现"准实时"。
 *
 * 凭据：data/gitcode.json（已在 .gitignore 中，绝不入库）：
 *   { "user": "zyx_ly", "token": "<个人访问令牌>", "repo": "zcode-usage", "branch": "pages" }
 *
 * 手动发布：npm run publish
 * 自动发布：服务运行时按 settings.publish（enabled / intervalMin 分钟）周期推送
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getDaily,
  getTrend,
  getModelTotals,
  getTodayByModel,
  getOverview,
  getDetailSince,
  type DailyRow,
} from './db.ts';
import { loadSettings } from './settings.ts';
import { buildProviderList } from './providers.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'web');
const DIST = path.join(ROOT, 'dist');

interface GitCodeConfig {
  user: string;
  token: string;
  repo: string;
  branch: string;
}

function readGitCodeConfig(): GitCodeConfig | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'gitcode.json'), 'utf8'));
    if (cfg?.user && cfg?.token && cfg?.repo) return cfg;
  } catch {
    /* 未配置 */
  }
  return null;
}

function buildDataJson(): object {
  const daily: DailyRow[] = getDaily();
  return {
    publishedAt: Date.now(),
    snapshot: {
      generatedAt: Date.now(),
      overview: getOverview(daily),
      daily,
      trend7: getTrend(7),
      trend30: getTrend(30),
      modelTotals: getModelTotals(),
      today: getTodayByModel(),
    },
    providers: buildProviderList(loadSettings(), getModelTotals()),
    settings: loadSettings(),
  };
}

function buildCsv(days: number): string {
  const rows = getDetailSince(days);
  const { prices } = loadSettings();
  const lines = ['日期,供应商,模型,请求数,输入Tokens,输出Tokens,缓存读Tokens,缓存写Tokens,总量Tokens,估算成本(元)'];
  for (const r of rows) {
    const total = r.si + r.so;
    const price = prices[`${r.provider}|${r.model}`];
    const cost = price ? ((price.in * r.si + price.out * r.so) / 1e6).toFixed(4) : '';
    lines.push(
      [r.d, r.provider, r.model, r.req, r.si, r.so, r.cr, r.cw, total, cost]
        .map((v) => {
          const s = String(v);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    );
  }
  return '\ufeff' + lines.join('\r\n');
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

function git(cwd: string, args: string[], token: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  } catch (e) {
    const err = e as { stderr?: unknown; stdout?: unknown; message?: unknown };
    throw new Error(scrub([err.stderr, err.stdout, err.message].map(String).join('\n'), token));
  }
}

function ensureDistRepo(cfg: GitCodeConfig): void {
  if (fs.existsSync(path.join(DIST, '.git'))) return;
  fs.mkdirSync(DIST, { recursive: true });
  git(DIST, ['init', '-b', cfg.branch || 'pages'], cfg.token);
  git(DIST, ['config', 'user.name', cfg.user], cfg.token);
  git(DIST, ['config', 'user.email', `${cfg.user}@noreply.gitcode.com`], cfg.token);
}

function cleanDist(): void {
  for (const name of fs.readdirSync(DIST)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(DIST, name), { recursive: true, force: true });
  }
}

function copyDir(src: string, dest: string): void {
  // 不用 fs.cpSync：Node 25 在含非 ASCII 的 Windows 路径下 cpSync 会静默崩溃（exit 127）
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeDist(): void {
  cleanDist();
  copyDir(WEB, DIST);

  // index.html：绝对路径改相对路径 + 打开静态数据开关
  let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  html = html
    .replaceAll('href="/style.css"', 'href="./style.css"')
    .replaceAll('src="/vendor/echarts.min.js"', 'src="./vendor/echarts.min.js"')
    .replaceAll('src="/app.js"', 'src="./app.js"');
  html = html.replace(
    '<script type="module" src="./app.js"></script>',
    '<script>window.USE_STATIC_DATA = true;</script>\n<script type="module" src="./app.js"></script>'
  );
  fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');

  fs.writeFileSync(path.join(DIST, 'data.json'), JSON.stringify(buildDataJson()), 'utf8');
  fs.writeFileSync(path.join(DIST, 'usage.csv'), buildCsv(30), 'utf8');
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');
}

export function publishNow(): { ok: boolean; message: string } {
  const cfg = readGitCodeConfig();
  if (!cfg) return { ok: false, message: '未配置 data/gitcode.json（user/token/repo），跳过发布' };
  const branch = cfg.branch || 'pages';
  try {
    ensureDistRepo(cfg);
    writeDist();
    git(DIST, ['add', '-A'], cfg.token);
    let hasCommit = true;
    try {
      git(DIST, ['rev-parse', 'HEAD'], cfg.token);
    } catch {
      hasCommit = false;
    }
    const msg = `snapshot ${new Date().toISOString()}`;
    if (hasCommit) git(DIST, ['commit', '--amend', '-m', msg], cfg.token);
    else git(DIST, ['commit', '-m', msg], cfg.token);
    const url = `https://${cfg.user}:${cfg.token}@gitcode.com/${cfg.user}/${cfg.repo}.git`;
    git(DIST, ['push', '--force', url, `HEAD:refs/heads/${branch}`], cfg.token);
    return { ok: true, message: `已推送到 ${cfg.user}/${cfg.repo}@${branch}` };
  } catch (e) {
    return { ok: false, message: scrub(String((e as Error).message ?? e), cfg.token).slice(0, 500) };
  }
}

let publishing = false;

/** 供服务端定时调用：吞掉异常只打日志 */
export function publishSafe(): void {
  if (publishing) return;
  publishing = true;
  try {
    const r = publishNow();
    console.log(`[publish] ${r.ok ? '✔ 成功' : '✘ 失败'} ${new Date().toLocaleTimeString('zh-CN')} ${r.message}`);
  } finally {
    publishing = false;
  }
}

// 显式运行本文件时发布（npm run publish / node server/publish.ts --run）
if (process.argv.includes('--run')) {
  const r = publishNow();
  console.log(`[publish] ${r.ok ? '✔ 成功' : '✘ 失败'} ${r.message}`);
  if (!r.ok) process.exitCode = 1;
}
