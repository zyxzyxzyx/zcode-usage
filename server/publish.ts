/**
 * 静态站点发布器：构建 dist/（单文件自包含 index.html + data.json 快照 + usage.csv）并推送到 GitHub Pages。
 *
 * 背景：GitCode 无 Pages 服务；GitHub Pages 走 gh-pages 分支，首次发布后自动调用
 * GitHub API 开通 Pages（站点：https://<user>.github.io/<repo>/）。
 * 本地按 settings.publish 周期自动推送快照，实现"准实时"线上页面。
 *
 * 凭据：data/publish.json（已在 .gitignore 中，绝不入库）：
 *   { "platform": "github", "user": "zyxzyxzyx", "token": "<PAT>", "repo": "zcode-usage", "branch": "gh-pages" }
 *
 * 手动发布：npm run publish
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

interface PublishConfig {
  platform: 'github';
  user: string;
  token: string;
  repo: string;
  branch: string;
}

function readPublishConfig(): PublishConfig | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'publish.json'), 'utf8'));
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
    // windowsHide: 服务以无控制台方式常驻，不加会在每次 git 调用时弹出可见命令行窗口
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  } catch (e) {
    const err = e as { stderr?: unknown; stdout?: unknown; message?: unknown };
    throw new Error(scrub([err.stderr, err.stdout, err.message].map(String).join('\n'), token));
  }
}

function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归删除。本机沙箱下 fs.rmSync 可能被静默忽略（实测），故按
 * fs.rmSync → rm -rf → 手动逐个删除 的顺序兜底，每步都验证结果。
 */
function rmrf(p: string): void {
  if (!pathExists(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 忽略，走兜底 */
  }
  if (!pathExists(p)) return;
  try {
    spawnSync('rm', ['-rf', p], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* 忽略，走兜底 */
  }
  if (!pathExists(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) rmrf(path.join(p, name));
    try {
      fs.rmdirSync(p);
    } catch {
      /* 最后一次尝试失败则放弃 */
    }
  } else {
    try {
      fs.unlinkSync(p);
    } catch {
      /* 忽略 */
    }
  }
}

function cleanDist(): void {
  for (const name of fs.readdirSync(DIST)) {
    if (name === '.git') continue;
    rmrf(path.join(DIST, name));
  }
}

function writeDist(): void {
  cleanDist();
  // 整站打包成"单文件自包含 index.html"（内联 CSS/JS/ECharts），
  // data.json / usage.csv 单独存放供页面 fetch（fetch 不受 MIME 限制）。
  // 注意：replace 的替换串必须用函数形式，否则 $&/$' 等序列会被解释，破坏内联的 JS。
  const tpl = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const echarts = fs.readFileSync(path.join(WEB, 'vendor', 'echarts.min.js'), 'utf8');
  const appjs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const html = tpl
    .replace('<link rel="stylesheet" href="/style.css" />', () => `<style>\n${css}\n</style>`)
    .replace('<script src="/vendor/echarts.min.js"></script>', () => `<script>\n${echarts}\n</script>`)
    .replace(
      '<script type="module" src="/app.js"></script>',
      () => `<script>window.USE_STATIC_DATA = true;</script>\n<script>\n${appjs}\n</script>`
    );
  fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');

  fs.writeFileSync(path.join(DIST, 'data.json'), JSON.stringify(buildDataJson()), 'utf8');
  fs.writeFileSync(path.join(DIST, 'usage.csv'), buildCsv(30), 'utf8');
}

function ensureDistRepo(cfg: PublishConfig, branch: string): void {
  if (!fs.existsSync(path.join(DIST, '.git'))) {
    fs.mkdirSync(DIST, { recursive: true });
    git(DIST, ['init', '-b', branch], cfg.token);
    git(DIST, ['config', 'user.name', cfg.user], cfg.token);
    git(DIST, ['config', 'user.email', `${cfg.user}@noreply.github.com`], cfg.token);
    return;
  }
  const cur = git(DIST, ['rev-parse', '--abbrev-ref', 'HEAD'], cfg.token).trim();
  if (cur && cur !== branch) git(DIST, ['branch', '-m', cur, branch], cfg.token);
}

/** 首次发布后自动开通 GitHub Pages（幂等：已开通则跳过） */
async function ensureGithubPages(cfg: PublishConfig, branch: string): Promise<string> {
  const api = `https://api.github.com/repos/${cfg.user}/${cfg.repo}/pages`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'zcode-usage-publisher',
  };
  const probe = await fetch(api, { headers });
  if (probe.ok) {
    const info = (await probe.json()) as { html_url?: string };
    return info.html_url ?? '';
  }
  if (probe.status !== 404) {
    throw new Error(`GitHub Pages API 探测失败：${probe.status}`);
  }
  const create = await fetch(api, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { branch, path: '/' } }),
  });
  if (!create.ok && create.status !== 409) {
    throw new Error(`开通 GitHub Pages 失败：${create.status} ${await create.text()}`);
  }
  return `https://${cfg.user}.github.io/${cfg.repo}/`;
}

export async function publishNow(): Promise<{ ok: boolean; message: string; url?: string }> {
  const cfg = readPublishConfig();
  if (!cfg) return { ok: false, message: '未配置 data/publish.json（platform/user/token/repo），跳过发布' };
  const branch = cfg.branch || 'gh-pages';
  try {
    ensureDistRepo(cfg, branch);
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
    const host = cfg.platform === 'github' ? 'github.com' : 'gitcode.com';
    const url = `https://${cfg.user}:${cfg.token}@${host}/${cfg.user}/${cfg.repo}.git`;
    git(DIST, ['push', '--force', url, `HEAD:refs/heads/${branch}`], cfg.token);

    let siteUrl = '';
    if (cfg.platform === 'github') {
      try {
        siteUrl = await ensureGithubPages(cfg, branch);
      } catch (e) {
        return {
          ok: true,
          message: `已推送 ${cfg.user}/${cfg.repo}@${branch}，但 Pages 开通失败：${scrub(String((e as Error).message ?? e), cfg.token)}`,
        };
      }
    }
    return { ok: true, message: `已推送到 ${cfg.user}/${cfg.repo}@${branch}`, url: siteUrl || undefined };
  } catch (e) {
    return { ok: false, message: scrub(String((e as Error).message ?? e), cfg.token).slice(0, 500) };
  }
}

let publishing = false;

/** 供服务端定时调用：吞掉异常只打日志 */
export function publishSafe(): void {
  if (publishing) return;
  publishing = true;
  publishNow()
    .then((r) => {
      console.log(`[publish] ${r.ok ? '✔ 成功' : '✘ 失败'} ${new Date().toLocaleTimeString('zh-CN')} ${r.message}`);
    })
    .catch((e) => {
      console.log(`[publish] ✘ 异常 ${String(e).slice(0, 300)}`);
    })
    .finally(() => {
      publishing = false;
    });
}

// 显式运行本文件时发布（npm run publish / node server/publish.ts --run）
if (process.argv.includes('--run')) {
  publishNow().then((r) => {
    console.log(`[publish] ${r.ok ? '✔ 成功' : '✘ 失败'} ${r.message}${r.url ? ` → ${r.url}` : ''}`);
    if (!r.ok) process.exitCode = 1;
  });
}
