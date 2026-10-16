import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload для локального окна «О программе» (renderer/about.html).
 *
 * БЕЗОПАСНОСТЬ:
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true (см. main.ts).
 *  - Окно About НЕ имеет доступа к сайту и не совершает сетевых запросов.
 *  - Наружу отдаём только узкий API: получить версию, открыть локальный
 *    правовой документ, открыть внешнюю ссылку через системный браузер,
 *    запросить проверку обновлений (проксирует существующий IPC 'check-updates').
 */
contextBridge.exposeInMainWorld('mazalive', {
  about: {
    info: () => ipcRenderer.invoke('about-info'),
    openDoc: (kind: 'license' | 'privacy', lang: 'ru' | 'en') =>
      ipcRenderer.invoke('about-open-doc', { kind, lang }),
    openExternal: (url: string) => ipcRenderer.invoke('about-open-external', { url }),
    checkUpdates: () => ipcRenderer.invoke('check-updates'),
  },
})
