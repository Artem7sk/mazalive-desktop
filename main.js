const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'MazaLive',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#07090f',
    show: false,
  })

  // Загружаем mazlive.com
  win.loadURL('https://mazlive.com')

  // Показываем окно когда загрузилось
  win.once('ready-to-show', () => {
    win.show()
  })

  // Внешние ссылки открываем в браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://mazlive.com')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
