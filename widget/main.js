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
const H_BIG = 186;

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

function setExpanded(big) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: W, height: big ? H_BIG : H_SMALL });
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
      { label: '启动数据服务', click: () => startService() },
      { type: 'separator' },
      { label: '退出悬浮框', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function startService() {
  const bat = path.join(ROOT, '启动仪表盘.bat');
  log('尝试拉起数据服务');
  try {
    spawn('cmd.exe', ['/c', `start "" "${bat}"`], { cwd: ROOT, detached: true, windowsHide: true }).unref();
  } catch (e) {
    log(`拉起失败: ${e}`);
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
    ipcMain.on('expand', (_e, big) => setExpanded(Boolean(big)));
    ipcMain.on('set-opacity', (_e, v) => {
      win?.setOpacity(v);
      saveCfg({ opacity: v });
    });
    ipcMain.on('open-dashboard', () => shell.openExternal(API));
    ipcMain.on('start-service', () => startService());
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
