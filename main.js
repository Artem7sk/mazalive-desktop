const { app, BrowserWindow, shell, dialog } = require('electron')
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
    },
    backgroundColor: '#07090f',
    show: false,
  })

  win.loadURL('https://mazlive.com')

  win.once('ready-to-show', () => {
    win.show()
    // Проверяем обновления через 3 секунды после запуска
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://mazlive.com')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
}

// Автообновление
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
