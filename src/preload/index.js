const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染层唯一的对外接口。渲染层没有 Node 权限，
 * 所有 PTY 能力都通过这里的 IPC 走主进程。
 */
contextBridge.exposeInMainWorld('multi', {
  info: () => ipcRenderer.invoke('app:info'),
  shells: () => ipcRenderer.invoke('shells:list'),
  openWindow: () => ipcRenderer.invoke('window:open'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),

  recentPaths: () => ipcRenderer.invoke('paths:recent'),
  touchPath: (dir) => ipcRenderer.invoke('paths:touch', dir),
  forgetPath: (dir) => ipcRenderer.invoke('paths:forget', dir),
  pickDirectory: () => ipcRenderer.invoke('paths:pick'),
  checkPath: (dir) => ipcRenderer.invoke('paths:check', dir),

  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
  list: () => ipcRenderer.invoke('pty:list'),

  saveSession: (state) => ipcRenderer.invoke('session:save', state),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  closeSelf: () => ipcRenderer.invoke('window:close'),

  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pty:event', listener)
    return () => ipcRenderer.removeListener('pty:event', listener)
  },
})
