const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  expand: (big) => ipcRenderer.send('expand', big),
  setOpacity: (v) => ipcRenderer.send('set-opacity', v),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  startService: () => ipcRenderer.send('start-service'),
  showMenu: () => ipcRenderer.send('show-menu'),
  setTrayIcon: (dataUrl) => ipcRenderer.send('set-tray-icon', dataUrl),
  setTrayTooltip: (text) => ipcRenderer.send('set-tray-tooltip', text),
  quit: () => ipcRenderer.send('quit'),
});
