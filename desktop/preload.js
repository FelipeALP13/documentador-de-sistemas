const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('documentador', {
  defaults: () => ipcRenderer.invoke('defaults'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: folder => ipcRenderer.invoke('open-folder', folder),
  scan: input => ipcRenderer.invoke('scan', input),
  checkImages: input => ipcRenderer.invoke('check-images', input),
  generate: input => ipcRenderer.invoke('generate', input),
  onProgress: callback => ipcRenderer.on('progress', (_event, text) => callback(text)),
});
