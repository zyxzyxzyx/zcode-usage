/* ZCode Token 用量仪表盘 前端逻辑 */

const PALETTE = ['#3b82f6', '#10b981', '#a855f7', '#ef4444', '#f59e0b', '#14b8a6', '#6366f1', '#ec4899', '#84cc16', '#f97316'];

// GitCode Pages 静态部署时由发布器注入 window.USE_STATIC_DATA=true，页面改为读取 data.json 快照
const STATIC_MODE = window.USE_STATIC_DATA === true;
let staticData = null;

let snapshot = null;
let settings = { quotas: {}, prices: {}, providerAliases: {} };
let providers = [];
let selectedProviderId = null;
let heatMode = 'daily';
let trendDays = 7;
const charts = {};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---------- 格式化 ---------- */
function trim1(x) {
  return x >= 10000 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
}
function fmtTokens(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (n >= 1e8) return trim1(n / 1e8) + '亿';
  if (n >= 1e4) return trim1(n / 1e4) + '万';
  return Math.round(n).toLocaleString('zh-CN');
}
function fmtDuration(ms) {
  if (!ms) return '0分钟';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
}
function fmtDateCN(d) {
  const [, m, dd] = d.split('-');
  return `${+m}月${+dd}日`;
}
function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function weekStart(dstr) {
  const t = new Date(dstr + 'T00:00:00');
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return localDate(t);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ---------- 页面切换 ---------- */
function showPage(name) {
  $('#page-stats').hidden = name !== 'stats';
  $('#page-settings').hidden = name !== 'settings';
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'settings') {
    loadSettingsPage();
  } else {
    Object.values(charts).forEach((c) => c.resize());
  }
}

/* ---------- 使用统计页 ---------- */
function renderStats() {
  if (!snapshot) return;
  const meta = snapshot.meta || {};
  const errEl = $('#global-error');
  if (meta.error) {
    errEl.hidden = false;
    errEl.textContent = `数据库读取失败：${meta.error}`;
  } else {
    errEl.hidden = true;
  }

  const ov = snapshot.overview || {};
  const cards = [
    [fmtTokens(ov.totalTokens || 0), '累计 Token 数'],
    [fmtTokens(ov.peakDayTokens || 0), '峰值 Token 数'],
    [fmtDuration(ov.maxTurnMs || 0), '最长聊天时长'],
    [`${ov.currentStreak || 0} 天`, '当前连续天数'],
    [`${ov.longestStreak || 0} 天`, '最长连续天数'],
  ];
  $('#stat-cards').innerHTML = cards
    .map(([n, l], i) => `<div class="stat${i ? ' stat-divided' : ''}"><div class="stat-num">${n}</div><div class="stat-label">${l}</div></div>`)
    .join('');

  renderHeat();
  renderTrend();
  renderDonut();
  $('#stats-foot').innerHTML = STATIC_MODE
    ? `GitHub Pages 在线快照 · 发布于 ${new Date(staticData.publishedAt).toLocaleString('zh-CN')} · 页面每 60 秒自动拉取最新快照 · 本机运行仪表盘可 2 秒实时`
    : `数据源：<code>${esc(meta.dbPath || '')}</code>（只读）· 每 2 秒自动刷新 · 最后更新 ${new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN')}`;
  updateTitle();
}

/** 浏览器标签页标题实时显示供应商剩余额度百分比 */
function updateTitle() {
  const entries = Object.entries(settings.providerQuotas || {});
  if (!entries.length) {
    document.title = 'ZCode Token 用量统计';
    return;
  }
  const parts = entries.map(([pid, quota]) => {
    const used = (snapshot?.today || []).filter((r) => r.provider === pid).reduce((a, r) => a + r.tok, 0);
    const name = settings.providerAliases[pid] || providers.find((x) => x.id === pid)?.name || pid.slice(0, 8);
    const remainPct = Math.max(0, 100 - (used / quota) * 100);
    return `${name}剩余${trim1(remainPct)}%`;
  });
  document.title = `ZCode用量 · ${parts.join(' · ')}`;
}

function renderHeat() {
  const daily = snapshot.daily || [];
  charts.heat ??= echarts.init($('#heat-chart'));
  const chart = charts.heat;
  const today = localDate(new Date());
  const start = localDate(new Date(Date.now() - 330 * 86400000));

  if (heatMode === 'weekly') {
    const weeks = new Map();
    for (const r of daily) weeks.set(weekStart(r.d), (weeks.get(weekStart(r.d)) || 0) + r.tok);
    const xs = [...weeks.keys()].sort();
    chart.setOption(
      {
        tooltip: { trigger: 'axis', valueFormatter: (v) => `${fmtTokens(v)} tokens` },
        grid: { left: 64, right: 24, top: 20, bottom: 30 },
        xAxis: { type: 'category', data: xs, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e5e7eb' } }, axisLabel: { color: '#9ca3af', formatter: fmtDateCN } },
        yAxis: { type: 'value', axisLabel: { color: '#9ca3af', formatter: fmtTokens }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
        series: [{ type: 'bar', data: xs.map((w) => weeks.get(w)), itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 22 }],
      },
      true
    );
    return;
  }

  const data = [];
  let acc = 0;
  for (const r of daily) {
    acc += r.tok;
    data.push([r.d, heatMode === 'cumulative' ? acc : r.tok]);
  }
  const maxTok = Math.max(1, ...data.map((x) => x[1]));
  chart.setOption(
    {
      tooltip: { formatter: (p) => `${p.value[0]}<br/>${fmtTokens(p.value[1])} tokens` },
      visualMap: {
        show: false, min: 0, max: maxTok,
        inRange: { color: ['#dbe7f7', '#a8c8f4', '#6ba3ef', '#3b82f6', '#1d4ed8'] },
      },
      calendar: {
        top: 22, left: 16, right: 16, bottom: 34,
        cellSize: [13, 13],
        range: [start, today],
        splitLine: { show: false },
        itemStyle: { color: '#eef0f2', borderColor: '#ffffff', borderWidth: 2, borderRadius: 3 },
        dayLabel: { show: false },
        monthLabel: {
          position: 'bottom', color: '#9ca3af', fontSize: 11,
          nameMap: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
        },
        yearLabel: { show: false },
      },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
    },
    true
  );
}

function renderTrend() {
  const rows = (trendDays === 7 ? snapshot.trend7 : snapshot.trend30) || [];
  charts.trend ??= echarts.init($('#trend-chart'));
  const chart = charts.trend;

  const dates = [];
  for (let i = trendDays - 1; i >= 0; i--) dates.push(localDate(new Date(Date.now() - i * 86400000)));

  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, new Map());
    const m = byModel.get(r.model);
    m.set(r.d, (m.get(r.d) || 0) + r.tok);
  }
  const entries = [...byModel.entries()]
    .map(([k, m]) => ({ k, total: [...m.values()].reduce((a, b) => a + b, 0), m }))
    .sort((a, b) => b.total - a.total);
  const top = entries.slice(0, 6);
  const rest = entries.slice(6);

  const series = top.map((e, i) => ({
    name: e.k, type: 'line', smooth: true, showSymbol: false,
    lineStyle: { width: 2 }, itemStyle: { color: PALETTE[i % PALETTE.length] },
    data: dates.map((d) => e.m.get(d) || 0),
  }));
  if (rest.length) {
    const rm = new Map();
    for (const e of rest) for (const [d, v] of e.m) rm.set(d, (rm.get(d) || 0) + v);
    series.push({
      name: '其他', type: 'line', smooth: true, showSymbol: false,
      lineStyle: { width: 2, type: 'dashed' }, itemStyle: { color: '#9ca3af' },
      data: dates.map((d) => rm.get(d) || 0),
    });
  }

  chart.setOption(
    {
      legend: { top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: '#4b5563', fontSize: 12 } },
      grid: { left: 64, right: 24, top: 36, bottom: 30 },
      xAxis: { type: 'category', boundaryGap: false, data: dates, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e5e7eb' } }, axisLabel: { color: '#9ca3af', formatter: fmtDateCN } },
      yAxis: { type: 'value', axisLabel: { color: '#9ca3af', formatter: fmtTokens }, splitLine: { lineStyle: { color: '#f3f4f6' } } },
      tooltip: { trigger: 'axis', valueFormatter: (v) => `${fmtTokens(v)} tokens` },
      series,
    },
    true
  );
}

function renderDonut() {
  const totals = snapshot.modelTotals || [];
  const total = totals.reduce((a, b) => a + b.tok, 0);
  charts.donut ??= echarts.init($('#donut-chart'));
  charts.donut.setOption({
    tooltip: { formatter: (p) => `${esc(p.name)}<br/>${fmtTokens(p.value)} tokens（${p.percent}%）` },
    series: [{
      type: 'pie', radius: ['64%', '82%'], center: ['50%', '50%'],
      label: { show: false }, labelLine: { show: false }, emphasis: { scale: false },
      data: totals.map((r, i) => ({ name: r.model, value: r.tok, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
    }],
  });
  $('#donut-center').innerHTML = `<div class="dc-num">${fmtTokens(total)}</div><div class="dc-sub">tokens</div>`;
  $('#donut-list').innerHTML = totals
    .map((r, i) => `
      <div class="drow">
        <span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span class="dname" title="${esc(r.provider)} · ${esc(r.model)}">${esc(r.model)}</span>
        <span class="dtok">${fmtTokens(r.tok)} tokens</span>
        <span class="dpct">${total ? ((r.tok / total) * 100).toFixed(1) : '0.0'}%</span>
      </div>`)
    .join('');
}

/* ---------- 模型设置页 ---------- */
async function loadSettingsPage() {
  if (STATIC_MODE) {
    providers = staticData.providers || [];
    settings = staticData.settings || settings;
    if (!selectedProviderId || !providers.some((p) => p.id === selectedProviderId)) {
      selectedProviderId = (providers.find((p) => p.enabled) ?? providers[0])?.id ?? null;
    }
    renderProviderList();
    renderProviderDetail();
    $('#settings-foot').textContent = '在线快照为只读；额度与价格请在本地仪表盘中修改。';
    return;
  }
  try {
    const [pv, st] = await Promise.all([
      fetch('/api/providers').then((r) => r.json()),
      fetch('/api/settings').then((r) => r.json()),
    ]);
    providers = pv.providers || [];
    settings = st;
    if (!selectedProviderId || !providers.some((p) => p.id === selectedProviderId)) {
      selectedProviderId = (providers.find((p) => p.enabled) ?? providers[0])?.id ?? null;
    }
    renderProviderList();
    renderProviderDetail();
    $('#settings-foot').textContent = '额度与价格保存在本仪表盘的 data/settings.json，与 ZCode 配置互不影响。';
  } catch (e) {
    toast('加载供应商失败：' + e.message);
  }
}

function renderProviderList() {
  const builtin = providers.filter((p) => p.builtin);
  const custom = providers.filter((p) => !p.builtin);
  const item = (p) => `
    <div class="pitem ${p.id === selectedProviderId ? 'selected' : ''}" data-id="${esc(p.id)}">
      <span class="pavatar">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="pname">${esc(p.name)}</span>
      ${p.enabled ? '<span class="pdot"></span>' : ''}
    </div>`;
  $('#provider-list').innerHTML =
    `<div class="section-label">智谱</div>` + builtin.map(item).join('') +
    (custom.length ? `<div class="section-label">自定义供应商</div>` + custom.map(item).join('') : '') +
    `<div class="pitem add" id="add-provider">＋ 添加供应商</div>`;
  $$('#provider-list .pitem[data-id]').forEach((el) => {
    el.onclick = () => {
      selectedProviderId = el.dataset.id;
      renderProviderList();
      renderProviderDetail();
    };
  });
  $('#add-provider').onclick = () => toast('一期暂不支持在此添加，请在 ZCode 中配置后会自动显示');
}

function renderProviderDetail() {
  const p = providers.find((x) => x.id === selectedProviderId);
  const main = $('#provider-detail');
  if (!p) {
    main.innerHTML = '<div class="empty">暂无供应商</div>';
    return;
  }
  const kindLabel = p.kind === 'anthropic' ? 'Anthropic 兼容' : p.kind === 'openai' ? 'OpenAI 兼容' : (p.kind || '—');
  const todayRows = (snapshot?.today || []).filter((r) => r.provider === p.id);
  const modelIds = [...new Set([...p.models.map((m) => m.id), ...todayRows.map((r) => r.model)])];

  // 供应商级总额度（如火山方舟网关 8000万/日，全模型共享）
  const usedProvider = todayRows.reduce((a, r) => a + r.tok, 0);
  const providerQuota = settings.providerQuotas?.[p.id];
  const pPct = providerQuota ? Math.min(100, (usedProvider / providerQuota) * 100) : null;
  const pCls = pPct == null ? '' : pPct >= 100 ? 'red' : pPct >= 90 ? 'amber' : 'green';
  const remaining = providerQuota ? Math.max(0, providerQuota - usedProvider) : null;
  const providerCard = providerQuota || todayRows.length
    ? `
      <div class="qcard full">
        <div class="qrow">
          <span class="qname">网关总额度（全模型共享）</span>
          <span class="qright"><span class="qreset">重置 23:59</span></span>
        </div>
        <div class="qbig ${pCls}">${remaining == null ? '—' : fmtTokens(remaining)}<span class="qbig-sub">剩余 tokens</span></div>
        <div class="qbar"><div class="qfill ${pCls}" style="width:${pPct ?? 0}%"></div></div>
        <div class="qnums">
          <span>已用 ${usedProvider.toLocaleString('zh-CN')}${providerQuota
            ? ` / <span class="qedit" data-k="${esc(p.id)}" data-scope="provider">${providerQuota.toLocaleString('zh-CN')}</span>`
            : ' tokens · <button class="link qedit" data-k="' + esc(p.id) + '" data-scope="provider">设置总额度</button>'}</span>
          ${providerQuota ? `<span> · 剩余 ${trim1(100 - pPct)}%</span>` : ''}
        </div>
      </div>`
    : '';

  const quotaCards = modelIds
    .map((mid) => {
      const used = todayRows.find((r) => r.model === mid)?.tok ?? 0;
      const qk = `${p.id}|${mid}`;
      const quota = settings.quotas[qk];
      const pct = quota ? Math.min(100, (used / quota) * 100) : null;
      const cls = pct == null ? '' : pct >= 100 ? 'red' : pct >= 90 ? 'amber' : 'green';
      return `
      <div class="qcard">
        <div class="qrow">
          <span class="qname">${esc(mid)}</span>
          <span class="qright">
            <span class="qpct ${cls}">${pct == null ? '—' : trim1(pct) + '%'}</span>
            <span class="qreset">重置 23:59</span>
          </span>
        </div>
        <div class="qbar"><div class="qfill ${cls}" style="width:${pct ?? 0}%"></div></div>
        <div class="qnums">
          <span>${used.toLocaleString('zh-CN')}${quota ? ` / <span class="qedit" data-k="${esc(qk)}">${quota.toLocaleString('zh-CN')}</span>` : ' tokens · <button class="link qedit" data-k="' + esc(qk) + '">设置每日额度</button>'}</span>
        </div>
      </div>`;
    })
    .join('');

  const modelRows = p.models
    .map((m) => {
      const tags = [];
      if (m.context >= 1e6) tags.push(`${trim1(m.context / 1e6)}M`);
      else if (m.context >= 1000) tags.push(`${Math.round(m.context / 1000)}K`);
      if (m.vision) tags.push('视觉');
      return `<div class="mrow"><span class="mname">${esc(m.id)}</span><span class="mtags">${tags.map((t) => `<span class="chip-s">${esc(t)}</span>`).join('')}</span></div>`;
    })
    .join('');

  const priceRows = modelIds
    .map((mid) => {
      const k = `${p.id}|${mid}`;
      const pr = settings.prices[k] || {};
      return `
      <div class="prow">
        <span class="pname-s" title="${esc(k)}">${esc(mid)}</span>
        <label>输入 ¥/M <input class="price" data-k="${esc(k)}" data-f="in" type="number" min="0" step="0.1" value="${pr.in ?? ''}"></label>
        <label>输出 ¥/M <input class="price" data-k="${esc(k)}" data-f="out" type="number" min="0" step="0.1" value="${pr.out ?? ''}"></label>
      </div>`;
    })
    .join('');

  main.innerHTML = `
    <div class="phead">
      <span class="pavatar big">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>
      <div class="ptitle">
        <div class="prow-title">
          <span class="pname-l">${esc(p.name)}</span>
          <span class="badge ${p.enabled ? 'on' : 'off'}">${p.enabled ? '已启用' : '未启用'}</span>
          <button class="link" id="rename-provider">重命名</button>
        </div>
        <div class="psub">${esc(p.baseURL || 'ZCode 云端托管连接')}${p.id.startsWith('builtin:') ? '' : ` · ${esc(p.id.slice(0, 8))}`}</div>
      </div>
      <div class="conn"><span class="muted-label">连接方式</span><span class="conn-val">${esc(kindLabel)}</span></div>
    </div>
    <div class="plan-card">
      <div class="plan-title">${esc(p.name)}<span class="plan-sub">今日余额（本地统计）· 每日重置 23:59</span></div>
      <div class="qgrid">${providerCard + quotaCards || '<div class="empty">今日暂无用量</div>'}</div>
    </div>
    <div class="sub-title">模型列表</div>
    <div class="mlist">${modelRows || '<div class="empty">—</div>'}</div>
    <div class="sub-title">价格设置（成本估算用，¥ / 百万 tokens，填入后趋势页可导出成本）</div>
    <div class="plist">${priceRows || '<div class="empty">—</div>'}</div>`;

  $('#rename-provider').onclick = () => renameProvider(p.id);
  $$('#provider-detail .qedit').forEach((el) => (el.onclick = () => editQuota(el.dataset.k, el)));
  $$('#provider-detail .price').forEach((el) => {
    el.onchange = async () => {
      const k = el.dataset.k;
      const f = el.dataset.f;
      settings.prices[k] ??= { in: 0, out: 0 };
      settings.prices[k][f] = Math.max(0, Number(el.value) || 0);
      await putSettings();
      toast('价格已保存');
    };
  });
}

function editQuota(key, el) {
  if (STATIC_MODE) return toast('静态站点为只读快照，请在本地仪表盘中修改');
  const scope = el.dataset.scope === 'provider' ? 'providerQuotas' : 'quotas';
  const store = settings[scope];
  const cur = store[key];
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.className = 'quota-input';
  input.value = cur ?? '';
  let cancelled = false;
  el.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    if (cancelled) return renderProviderDetail();
    const v = Number(input.value);
    if (Number.isFinite(v) && v > 0) settings[scope][key] = Math.round(v);
    else delete settings[scope][key];
    await putSettings();
    renderProviderDetail();
    updateTitle();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      cancelled = true;
      renderProviderDetail();
    }
  });
}

async function renameProvider(id) {
  if (STATIC_MODE) return toast('静态站点为只读快照，请在本地仪表盘中修改');
  const p = providers.find((x) => x.id === id);
  const name = prompt('供应商显示名称（仅影响本仪表盘的展示）', p?.name || '');
  if (!name || !name.trim()) return;
  settings.providerAliases[id] = name.trim();
  await putSettings();
  await loadSettingsPage();
}

async function putSettings() {
  if (STATIC_MODE) return;
  const r = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!r.ok) {
    toast('保存失败：' + (await r.text()));
    return;
  }
  updateTitle();
}

/* ---------- 事件绑定与启动 ---------- */
function bind() {
  $$('.tab').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));

  $$('#heat-mode button').forEach((b) => {
    b.onclick = () => {
      heatMode = b.dataset.mode;
      $$('#heat-mode button').forEach((x) => x.classList.toggle('active', x === b));
      renderHeat();
    };
  });

  $$('#trend-range button').forEach((b) => {
    b.onclick = () => {
      trendDays = Number(b.dataset.days);
      $$('#trend-range button').forEach((x) => x.classList.toggle('active', x === b));
      renderTrend();
    };
  });

  $('#export-btn').onclick = async () => {
    if (STATIC_MODE) {
      const csv = await fetch(`./usage.csv?t=${Date.now()}`).then((r) => r.text());
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zcode-usage-30d.csv';
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    window.open(`/api/export?days=${trendDays}`, '_blank');
  };

  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
}

async function init() {
  bind();

  if (STATIC_MODE) {
    const loadStatic = () => fetch(`./data.json?t=${Date.now()}`).then((r) => r.json());
    staticData = await loadStatic();
    snapshot = staticData.snapshot;
    settings = staticData.settings || settings;
    renderStats();
    // 每 60 秒拉取最新快照，跟随本地自动发布保持"准实时"
    setInterval(async () => {
      try {
        staticData = await loadStatic();
        snapshot = staticData.snapshot;
        settings = staticData.settings || settings;
        renderStats();
        if (!$('#page-settings').hidden && !$('#provider-detail input:focus')) {
          renderProviderDetail();
        }
      } catch {
        /* 快照暂时拉不到时保留旧数据 */
      }
    }, 60000);
    return;
  }

  try {
    snapshot = await fetch('/api/snapshot').then((r) => r.json());
  } catch (e) {
    $('#global-error').hidden = false;
    $('#global-error').textContent = '无法连接本地服务：' + e.message;
    return;
  }
  renderStats();

  // 额度配置提前加载，供标签页标题使用
  fetch('/api/settings')
    .then((r) => r.json())
    .then((s) => {
      settings = s;
      updateTitle();
    })
    .catch(() => {});

  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    snapshot = JSON.parse(e.data);
    renderStats();
    // 设置页打开且没有正在编辑的输入框时，同步刷新"今日余额"
    if (!$('#page-settings').hidden && !$('#provider-detail input:focus')) {
      renderProviderDetail();
    }
  });
  es.onerror = () => {}; // 断线后 EventSource 自动重连
}

init();
