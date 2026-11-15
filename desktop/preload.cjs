const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudioDesktop', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  close: () => ipcRenderer.invoke('desktop:close'),
  toggleMini: () => ipcRenderer.invoke('desktop:toggle-mini'),
  setMini: flag => ipcRenderer.invoke('desktop:set-mini', Boolean(flag)),
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  syncSettings: settings => ipcRenderer.invoke('desktop:sync-settings', settings),
  onMiniChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, isMini) => callback(Boolean(isMini));
    ipcRenderer.on('desktop:mini-changed', listener);
    return () => ipcRenderer.removeListener('desktop:mini-changed', listener);
  },
});
