// preload.js
const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  let deviceId;
  try {
    deviceId = await ipcRenderer.invoke('device:getId');
  } catch {
    deviceId = 'fallback-' + Math.random().toString(36).slice(2);
  }

  // Exponer el deviceId estable al renderer
  contextBridge.exposeInMainWorld('deviceInfo', { deviceId });

  // Exponer un puente mínimo para invocar IPC desde el renderer
  contextBridge.exposeInMainWorld('electron', {
    ipcRenderer: {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)
    }
  });
})();
