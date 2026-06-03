const { app, BrowserWindow, shell, dialog, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'MazaLive',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:mazalive',
    },
    backgroundColor: '#07090f',
    show: false,
  })

  win.loadURL('https://mazlive.com')

  win.once('ready-to-show', () => {
    win.show()
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000)
  })

  // Открываем ссылки в том же окне если это mazlive домен
  win.webContents.setWindowOpenHandler(({ url }) => {
    const isMazalive = url.includes('mazlive.com') || 
                       url.includes('mazlive.com') ||
                       url.startsWith('https://games.mazlive.com')
    if (!isMazalive) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // Навигация в том же окне для mazlive доменов
  win.webContents.on('will-navigate', (event, url) => {
    const isMazalive = url.includes('mazlive.com') ||
                       url.includes('mazlive.com')
    if (!isMazalive) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // Новые окна для mazlive открываем в том же окне
  win.webContents.on('new-window', (event, url) => {
    const isMazalive = url.includes('mazlive.com')
    if (isMazalive) {
      event.preventDefault()
      win.loadURL(url)
    } else {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
}

autoUpdater.on('update-available', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Доступно обновление',
    message: 'Новая версия MazaLive доступна. Скачиваем...',
    buttons: ['OK']
  })
})

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Обновление готово',
    message: 'Обновление загружено. Перезапустить сейчас?',
    buttons: ['Перезапустить', 'Позже']
  }).then(result => {
    if (result.response === 0) autoUpdater.quitAndInstall()
  })
})

autoUpdater.on('error', (err) => {
  console.log('AutoUpdater error:', err)
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
