import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mazalive', {
  getUser: () => ipcRenderer.invoke('get-user'),
  logout: () => ipcRenderer.invoke('logout'),
  launchGame: (gameSlug: string, roomId: string) =>
    ipcRenderer.invoke('launch-game', { gameSlug, roomId }),
  closeGame: () => ipcRenderer.invoke('close-game'),
  openBrowser: (url: string) => ipcRenderer.invoke('open-browser', url),

  onAuthRequired: (cb: () => void) => ipcRenderer.on('auth-required', cb),
  onSubscriptionRequired: (cb: (data: { plan: string }) => void) =>
    ipcRenderer.on('subscription-required', (_e, data) => cb(data)),
  onGameLaunched: (cb: (data: { gameSlug: string; roomId: string }) => void) =>
    ipcRenderer.on('game-launched', (_e, data) => cb(data)),
  onError: (cb: (data: { message: string }) => void) =>
    ipcRenderer.on('error', (_e, data) => cb(data)),
})
