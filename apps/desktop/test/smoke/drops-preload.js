'use strict';
// The drops smoke test's window.lurkbox: only what the Drops section uses, backed by the test's ipcMain handlers.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lurkbox', {
  dropsStatus: () => ipcRenderer.invoke('drops:status'),
  dropsOpen: () => ipcRenderer.invoke('drops:open'),
  dropsPad: (key) => ipcRenderer.invoke('drops:pad', key),
  dropsClose: () => ipcRenderer.invoke('drops:close'),
});
