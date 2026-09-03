/**
 * ZCode 用量悬浮框 v2.0 — Electron 主进程
 * 透明置顶无边框小窗；数据来自 v1.0 服务（127.0.0.1:5323）的 SSE/快照；
 * 设置持久化到项目 data/widget.json。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CFG_FILE = path.join(DATA_DIR, 'widget.json');
const LOG_FILE = path.join(DATA_DIR, 'widget.log');
const API = 'http://127.0.0.1:5323';
const W = 264;
const H_SMALL = 116;
const H_ROW = 21; // 展开区每行明细高度
const H_DETAIL_BASE = 36; // 展开区固定开销（分隔线 + 更新时间行）

let win = null;
let tray = null;
let quitting = false;

function log(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`);
  } catch {
    /* 日志失败不影响运行 */
  }
}

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCfg(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const cfg = { ...loadCfg(), ...patch };
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - W - 16, y: wa.y + 16, width: W, height: H_SMALL };
}

function createWindow() {
  const cfg = loadCfg();
  const b = defaultBounds();
  win = new BrowserWindow({
    x: Number.isFinite(cfg.x) ? cfg.x : b.x,
    y: Number.isFinite(cfg.y) ? cfg.y : b.y,
    width: W,
    height: H_SMALL,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setOpacity(Math.min(1, Math.max(0.3, Number(cfg.opacity ?? 0.85))));
  win.setAlwaysOnTop(true, 'screen-saver');
  if (cfg.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    win.show();
    log('悬浮框已显示');
  });
  let saveTimer;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win) return;
      const [x, y] = win.getPosition();
      saveCfg({ x, y });
    }, 400);
  });
  win.on('close', (e) => {
    // 点关闭 = 隐藏到托盘；真正退出走托盘菜单
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('console-message', (event) => {
    const { level, message } = event ?? {};
    if ((level ?? 0) >= 2) log(`renderer: ${message}`);
  });
}

function setExpanded(big, rows) {
  if (!win) return;
  const [x, y] = win.getPosition();
  const n = Math.max(0, Math.min(10, Number(rows) || 0));
  const h = big ? Math.min(400, H_SMALL + H_DETAIL_BASE + n * H_ROW) : H_SMALL;
  win.setBounds({ x, y, width: W, height: h });
}

function createTray() {
  // 先用空白占位，渲染进程加载后会送来动态绘制的图标
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('ZCode 用量悬浮框');
  tray.on('click', () => {
    if (!win) return;
    win.isVisible() ? win.hide() : win.show();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏悬浮卡', click: () => win && (win.isVisible() ? win.hide() : win.show()) },
      { type: 'separator' },
      {
        label: '鼠标穿透（在托盘关闭）',
        type: 'checkbox',
        checked: Boolean(loadCfg().clickThrough),
        click: (item) => {
          saveCfg({ clickThrough: item.checked });
          win?.setIgnoreMouseEvents(item.checked, { forward: true });
        },
      },
      { label: '打开仪表盘', click: () => shell.openExternal(API) },
      { label: '启动数据服务', click: () => startService('manual') },
      { type: 'separator' },
      { label: '退出悬浮框', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

let lastServiceStart = 0;

/** 探测数据服务是否存活 */
async function isServiceUp() {
  try {
    const r = await fetch(`${API}/api/snapshot`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 直接拉起 node 数据服务（绕过 bat/cmd 链——公司环境对 start 脚本链会"拒绝访问"）。
 *  auto 触发时带 5 分钟冷却；服务已运行则跳过。 */
async function startService(reason = 'manual') {
  try {
    if (await isServiceUp()) {
      log('数据服务已在运行，跳过启动');
      return true;
    }
  } catch {
    /* 探测失败继续尝试拉起 */
  }
  const now = Date.now();
  if (reason === 'auto' && now - lastServiceStart < 5 * 60000) return false;
  lastServiceStart = now;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
    const child = spawn('node', ['server/index.ts'], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    log(`已拉起数据服务 (${reason})`);
    return true;
  } catch (e) {
    log(`拉起数据服务失败: ${e}`);
    return false;
  }
}

function buildContextMenu() {
  const cfg = loadCfg();
  const opacity = Math.round((cfg.opacity ?? 0.85) * 100);
  return Menu.buildFromTemplate([
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: win ? win.isAlwaysOnTop() : true,
      click: (item) => {
        win?.setAlwaysOnTop(item.checked, 'screen-saver');
        saveCfg({ pinned: item.checked });
      },
    },
    {
      label: '不透明度',
      submenu: [50, 65, 80, 85, 95, 100].map((v) => ({
        label: `${v}%`,
        type: 'radio',
        checked: v === opacity,
        click: () => {
          win?.setOpacity(v / 100);
          saveCfg({ opacity: v / 100 });
        },
      })),
    },
    { type: 'separator' },
    { label: '打开仪表盘', click: () => shell.openExternal(API) },
    { label: '启动数据服务', click: () => startService() },
    { label: '隐藏到托盘', click: () => win?.hide() },
    { type: 'separator' },
    { label: '退出悬浮框', click: () => { quitting = true; app.quit(); } },
  ]);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    log('应用启动');
    createWindow();
    createTray();

    ipcMain.handle('get-config', () => loadCfg());
    ipcMain.on('expand', (_e, opts) => {
      const o = (typeof opts === 'object' && opts) || {};
      setExpanded(Boolean(o.big), Number(o.rows));
    });
    ipcMain.on('set-opacity', (_e, v) => {
      win?.setOpacity(v);
      saveCfg({ opacity: v });
    });
    ipcMain.on('open-dashboard', () => shell.openExternal(API));
    ipcMain.on('start-service', () => startService('manual'));
    ipcMain.on('auto-start-service', () => startService('auto'));
    ipcMain.on('show-menu', () => {
      if (!win) return;
      buildContextMenu().popup({ window: win });
    });
    ipcMain.on('set-tray-icon', (_e, dataUrl) => {
      try {
        tray?.setImage(nativeImage.createFromDataURL(String(dataUrl)));
      } catch {
        /* 忽略 */
      }
    });
    ipcMain.on('set-tray-tooltip', (_e, text) => tray?.setToolTip(String(text)));
    ipcMain.on('quit', () => { quitting = true; app.quit(); });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    log('应用退出');
  });
}
