const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = channel => callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('sidepad', {
  config: invoke('display:config'), list: invoke('display:list'), select: invoke('display:select'),
  active: invoke('display:active'), send: invoke('display:send'), disconnect: invoke('display:disconnect'),
  copy: invoke('display:copy'), settings: invoke('display:settings'), driverPage: invoke('display:driver-page'),
  installDriver: invoke('display:install-driver'),
  onViewer: subscribe('display:viewer'), onSignal: subscribe('display:signal'), onRetry: subscribe('display:retry'),
  onDisplays: subscribe('display:displays'), onRemoved: subscribe('display:removed'),
  onError: subscribe('display:error'), onDriverResult: subscribe('display:driver-result')
});
