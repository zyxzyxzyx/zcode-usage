/* ZCode 用量悬浮框 渲染进程：SSE 实时 + 轮询兜底 + 悬停展开 + 托盘图标绘制 */

const API = 'http://127.0.0.1:5323';
const PALETTE = { ok: '#16a34a', amber: '#d97706', red: '#dc2626', off: '#9ca3af' };

const $ = (sel) => document.querySelector(sel);
let expanded = false;
let pollTimer = null;
let sseOk = false;
let offlineSince = 0;
let lastAutoStart = 0;

function trim1(x) {
  return x >= 10000 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
}
function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (n >= 1e8) return trim1(n / 1e8) + '亿';
  if (n >= 1e4) return trim1(n / 1e4) + '万';
  return Math.round(n).toLocaleString('zh-CN');
}

function setColor(level) {
  const cls = level === 'ok' ? '' : level;
  $('#p-remain').className = `big ${cls}`;
  $('#p-pct').className = `pct ${cls}`;
  $('#p-fill').className = `fill ${cls}`;
}

function setOnline(ok, warn) {
  const dot = $('#status-dot');
  dot.className = `dot ${ok ? '' : warn ? 'warn' : 'off'}`;
  $('#offline').hidden = ok;
  if (ok) {
    offlineSince = 0;
  } else if (!offlineSince) {
    offlineSince = Date.now();
  }
  if (!ok) {
    setColor('off');
    $('#p-remain').textContent = '—';
    $('#p-pct').textContent = '—';
    $('#p-pct').classList.add('off');
  }
}

function render(snap) {
  const qs = snap.quotaSettings || {};
  const ids = Object.keys(qs.providerQuotas || {});
  if (!ids.length) {
    $('#p-name').textContent = '未配置额度';
    $('#p-used').textContent = '在仪表盘"模型设置"中设置总额度';
    $('#d-updated').textContent = `更新于 ${new Date(snap.generatedAt).toLocaleTimeString('zh-CN')}`;
    return;
  }
  const pid = ids[0];
  const quota = qs.providerQuotas[pid];
  const name = (qs.providerAliases && qs.providerAliases[pid]) || `自定义 ${pid.slice(0, 8)}`;
  const rows = (snap.today || []).filter((r) => r.provider === pid);
  const used = rows.reduce((a, r) => a + r.tok, 0);
  const remain = Math.max(0, quota - used);
  const remainPct = (remain / quota) * 100;
  const level = remainPct <= 10 ? 'red' : remainPct <= 20 ? 'amber' : 'ok';

  $('#p-name').textContent = name;
  $('#p-remain').textContent = fmtTokens(remain);
  $('#p-pct').textContent = trim1(remainPct) + '%';
  $('#p-fill').style.width = `${Math.min(100, (used / quota) * 100)}%`;
  $('#p-used').textContent = `已用 ${used.toLocaleString('zh-CN')} / ${quota.toLocaleString('zh-CN')}`;
  setColor(level);

  // 展开区：按模型明细（取用量最高的两个）
  const byModel = [...rows].sort((a, b) => b.tok - a.tok);
  $('#d-m1').textContent = byModel[0] ? `${fmtTokens(byModel[0].tok)} · ${byModel[0].model}` : '今日暂无';
  $('#d-m2').textContent = byModel[1] ? `${fmtTokens(byModel[1].tok)} · ${byModel[1].model}` : '';
  $('#d-updated').textContent =
    `${sseOk ? '实时' : '轮询'} · 更新于 ${new Date(snap.generatedAt).toLocaleTimeString('zh-CN')}`;

  window.api.setTrayTooltip(`${name}剩余 ${trim1(remainPct)}%`);
}

async function refresh() {
  try {
    const r = await fetch(`${API}/api/snapshot`);
    if (!r.ok) throw new Error(String(r.status));
    const snap = await r.json();
    if (!sseOk) setOnline(true);
    render(snap);
  } catch {
    if (!sseOk) {
      setOnline(false);
      // 离线自愈：持续 30 秒拿不到数据时自动拉起服务（5 分钟冷却，避免反复拉起）
      if (offlineSince && Date.now() - offlineSince > 30000 && Date.now() - lastAutoStart > 300000) {
        lastAutoStart = Date.now();
        window.api.autoStartService();
      }
    }
  }
}

function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, 2000);
}

function connectSSE() {
  try {
    const es = new EventSource(`${API}/api/events`);
    es.addEventListener('snapshot', (e) => {
      sseOk = true;
      setOnline(true);
      render(JSON.parse(e.data));
    });
    es.onerror = () => {
      sseOk = false;
      ensurePoll(); // SSE 断线时轮询兜底，恢复后 SSE 事件自动接管
    };
    es.onopen = () => {
      sseOk = true;
    };
  } catch {
    ensurePoll();
  }
  ensurePoll(); // 启动阶段先轮询，拿到首帧数据
  refresh();
}

/* 悬停展开 / 收起 */
const card = $('#card');
card.addEventListener('mouseenter', () => {
  expanded = true;
  card.classList.add('expanded');
  window.api.expand(true);
});
card.addEventListener('mouseleave', () => {
  expanded = false;
  card.classList.remove('expanded');
  window.api.expand(false);
});

$('#btn-menu').addEventListener('click', () => window.api.showMenu());
$('#btn-menu').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showMenu();
});
$('#btn-start').addEventListener('click', () => window.api.startService());

/* 双击卡片打开完整仪表盘 */
card.addEventListener('dblclick', () => window.api.openDashboard());

/* 托盘图标：渲染进程用 canvas 画一个环形进度图标 */
function sendTrayIcon(remainPct) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 32, 32);
  g.lineWidth = 5;
  g.strokeStyle = '#e5e7eb';
  g.beginPath();
  g.arc(16, 16, 11, 0, Math.PI * 2);
  g.stroke();
  const color = remainPct <= 10 ? PALETTE.red : remainPct <= 20 ? PALETTE.amber : PALETTE.ok;
  g.strokeStyle = color;
  g.beginPath();
  g.arc(16, 16, 11, -Math.PI / 2, -Math.PI / 2 + (Math.max(0, Math.min(100, remainPct)) / 100) * Math.PI * 2);
  g.stroke();
  g.fillStyle = color;
  g.font = 'bold 13px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('%', 16, 17);
  window.api.setTrayIcon(c.toDataURL());
}

async function init() {
  const cfg = await window.api.getConfig();
  if (typeof cfg.opacity === 'number') window.api.setOpacity(cfg.opacity); // 主进程启动时已应用
  connectSSE();
  // 图标先画一次占位，数据到达后随百分比刷新
  sendTrayIcon(100);
  setInterval(() => {
    const txt = $('#p-pct').textContent;
    const pct = parseFloat(txt);
    if (Number.isFinite(pct)) sendTrayIcon(pct);
  }, 10000);
}

init();
