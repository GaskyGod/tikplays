// electron/preload.js
const { contextBridge, ipcRenderer } = require('electron');

(async () => {
  let deviceId = '';
  try {
    deviceId = await ipcRenderer.invoke('device:getId'); // estable desde main
  } catch {}

  // Guarda también en localStorage para que la UI lo lea sin esperar
  try { localStorage.setItem('deviceId', deviceId || ''); } catch {}

  // expón APIs
  contextBridge.exposeInMainWorld('deviceInfo', { deviceId });
  contextBridge.exposeInMainWorld('electron', { ipcRenderer });

  // opcional: promesa para “esperar el ID”
  const ready = Promise.resolve(deviceId);
  contextBridge.exposeInMainWorld('waitForDeviceId', () => ready);
})();
