import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mazalive', {
  getUser: () => ipcRenderer.invoke('get-user'),
  logout: () => ipcRenderer.invoke('logout'),
  launchGame: (gameSlug: string, roomId: string) =>
    ipcRenderer.invoke('launch-game', { gameSlug, roomId }),
  closeGame: () => ipcRenderer.invoke('close-game'),
  openBrowser: (url: string) => ipcRenderer.invoke('open-browser', url),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),

  onAuthRequired: (cb: () => void) => ipcRenderer.on('auth-required', cb),
  onSubscriptionRequired: (cb: (data: { plan: string }) => void) =>
    ipcRenderer.on('subscription-required', (_e, data) => cb(data)),
  onGameLaunched: (cb: (data: { gameSlug: string; roomId: string }) => void) =>
    ipcRenderer.on('game-launched', (_e, data) => cb(data)),
  onUpdateProgress: (cb: (data: { percent: number }) => void) =>
    ipcRenderer.on('update-progress', (_e, data) => cb(data)),
  onError: (cb: (data: { message: string }) => void) =>
    ipcRenderer.on('error', (_e, data) => cb(data)),

  // ─── DESKTOP-GAME (GTA «Царь горы») — узкий API ───
  gta: {
    detect: () => ipcRenderer.invoke('gta-detect'),
    checkPath: (gamePath: string) => ipcRenderer.invoke('gta-check-path', { gamePath }),
    selectDir: () => ipcRenderer.invoke('gta-select-dir'),
    installMod: (gamePath?: string) => ipcRenderer.invoke('gta-install-mod', { gamePath }),
    uninstallMod: (gamePath?: string) => ipcRenderer.invoke('gta-uninstall-mod', { gamePath }),
    state: () => ipcRenderer.invoke('gta-state'),
    command: (action: string, count = 1) => ipcRenderer.invoke('gta-agent-command', { action, count }),
    testEvent: (evt: any) => ipcRenderer.invoke('gta-test-event', { evt }),
    stopAgent: () => ipcRenderer.invoke('gta-agent-stop'),
    connectStream: (username?: string, gamePath?: string) => ipcRenderer.invoke('gta-connect-stream', { username, gamePath }),
    getUsername: () => ipcRenderer.invoke('gta-get-username'),
    back: () => ipcRenderer.invoke('gta-back'),
    closePanel: () => ipcRenderer.invoke('gta-close-panel'),

    // Панель без GTA + настройки
    openPanel: () => ipcRenderer.invoke('gta-open-panel'),
    settingsGet: () => ipcRenderer.invoke('gta-settings-get'),
    settingsSet: (settings: any) => ipcRenderer.invoke('gta-settings-set', { settings }),
    settingsReset: () => ipcRenderer.invoke('gta-settings-reset'),
    applyCourse: (gamePath?: string) => ipcRenderer.invoke('gta-apply-course', { gamePath }),
    giftsCatalog: () => ipcRenderer.invoke('gta-gifts-catalog'),

    onRequired: (cb: (data: any) => void) => ipcRenderer.on('gta-required', (_e, d) => cb(d)),
    onStatus: (cb: (data: any) => void) => ipcRenderer.on('gta-status', (_e, d) => cb(d)),
    onAgentStatus: (cb: (data: any) => void) => ipcRenderer.on('gta-agent-status', (_e, d) => cb(d)),
    onCommand: (cb: (data: any) => void) => ipcRenderer.on('gta-command', (_e, d) => cb(d)),
    onAck: (cb: (data: any) => void) => ipcRenderer.on('gta-ack', (_e, d) => cb(d)),
  },
})
