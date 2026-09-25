import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  protocol,
  shell,
  Menu,
  dialog,
} from 'electron'
import path from 'path'
import axios from 'axios'
import { autoUpdater } from 'electron-updater'
import { tokenStore } from './auth/tokenStore'

const APP_VERSION = app.getVersion()

const WEB_URL = process.env.WEB_URL || 'https://mazlive.com'
const GAME_SERVER_URL = process.env.GAME_SERVER_URL || 'https://games.mazlive.com'
const DEV = process.env.NODE_ENV === 'development'

let authWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let gameWindow: BrowserWindow | null = null

// =============================================================
// Регистрация deep link протокола mazalive://
// =============================================================
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('mazalive', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('mazalive')
}

// =============================================================
// Создание Auth Window (WebView для логина через сайт)
// =============================================================
function createAuthWindow() {
  authWindow = new BrowserWindow({
    width: 500,
    height: 700,
    resizable: false,
    title: 'Mazlive — Вход',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  authWindow.loadURL(`${WEB_URL}/login?from=electron`)
  authWindow.setMenu(null)
  authWindow.setMenuBarVisibility(false)
  authWindow.setAutoHideMenuBar(true)

  // Перехватываем навигацию для получения session token
  authWindow.webContents.on('did-navigate', async (_event, url) => {
    // После успешного логина сайт редиректит на /dashboard
    if (url.includes('/dashboard')) {
      await captureSessionFromCookies()
    }
  })

  authWindow.on('closed', () => {
    authWindow = null
  })
}

// =============================================================
// Главное окно приложения
// =============================================================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    title: 'Mazlive',
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // Приложение показывает сайт — кабинет стримера
  mainWindow.loadURL(WEB_URL + '/dashboard')
  mainWindow.setMenu(null)
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(true)

  if (DEV) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// =============================================================
// Игровое окно — загружает игру с сервера (НЕ локальные файлы!)
// =============================================================
async function createGameWindow(gameSlug: string, roomId: string, roomToken: string) {
  // Закрываем предыдущее игровое окно
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.close()
  }

  gameWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    title: `Mazlive — ${gameSlug}`,
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Запрещаем открытие DevTools (защита исходников)
      devTools: DEV,
      // Запрещаем сохранение на диск
      partition: 'persist:game',
    },
  })

  gameWindow.setMenu(null)
  gameWindow.setMenuBarVisibility(false)
  gameWindow.setAutoHideMenuBar(true)

  // ✅ БЕЗОПАСНОСТЬ: игра загружается ТОЛЬКО с нашего сервера
  // Исходный HTML/JS никогда не попадает на диск пользователя
  // Читаем язык из cookie (выбран в дашборде). Дефолт — русский.
  let lang = 'ru'
  try {
    const gs = session.fromPartition('persist:game')
    const lc = await gs.cookies.get({ name: 'lang' })
    if (lc && lc.length && lc[0].value) lang = lc[0].value
    else {
      const mc = await session.defaultSession.cookies.get({ name: 'lang' })
      if (mc && mc.length && mc[0].value) lang = mc[0].value
    }
  } catch (e) {}
  const gameUrl = `${GAME_SERVER_URL}/games/${gameSlug}?room=${roomId}&token=${encodeURIComponent(roomToken)}&lang=${lang}`
  gameWindow.loadURL(gameUrl)

  // Блокируем открытие новых окон из игры
  gameWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Запрещаем навигацию за пределы нашего домена
  gameWindow.webContents.on('will-navigate', (event, navUrl) => {
    if (!navUrl.startsWith(GAME_SERVER_URL)) {
      event.preventDefault()
      shell.openExternal(navUrl)
    }
  })

  gameWindow.on('closed', () => {
    gameWindow = null
  })

  // Уведомляем главное окно
  mainWindow?.webContents.send('game-launched', { gameSlug, roomId })
}

// =============================================================
// Захват сессии из cookies после логина
// =============================================================
async function captureSessionFromCookies() {
  try {
    // Получаем cookie сессии из WebView
    const cookies = await session.defaultSession.cookies.get({ url: WEB_URL })
    const sessionCookie = cookies.find(
      (c) => c.name === 'authjs.session-token' || c.name === '__Secure-authjs.session-token'
    )

    if (!sessionCookie) return

    // Проверяем токен на сервере
    const res = await axios.get(`${WEB_URL}/api/auth/verify-subscription`, {
      headers: { Authorization: `Bearer ${sessionCookie.value}` },
    })

    if (res.data.valid) {
      // Сохраняем данные авторизации
      const user = res.data
      tokenStore.save({
        sessionToken: sessionCookie.value,
        userId: user.userId,
        userName: user.name || 'Streamer',
        userEmail: user.email || '',
        userImage: user.image || '',
      })

      // Закрываем окно авторизации
      authWindow?.close()

      // Открываем главное окно
      if (!mainWindow) createMainWindow()
      mainWindow?.focus()
    }
  } catch (err) {
    console.error('[Auth] Failed to capture session:', err)
  }
}

// =============================================================
// Проверка подписки перед запуском игры
// =============================================================
async function verifyAndLaunchGame(gameSlug: string, roomId: string) {
  const token = tokenStore.getToken()
  if (!token) {
    mainWindow?.webContents.send('auth-required')
    return
  }

  try {
    const res = await axios.get(`${WEB_URL}/api/auth/verify-subscription`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (res.data.valid && res.data.plan === 'pro') {
      await createGameWindow(gameSlug, roomId, res.data.roomToken)
    } else {
      mainWindow?.webContents.send('subscription-required', {
        plan: res.data.plan || 'free',
      })
    }
  } catch (err: any) {
    if (err.response?.status === 401) {
      tokenStore.clear()
      mainWindow?.webContents.send('auth-required')
    } else if (err.response?.status === 403) {
      mainWindow?.webContents.send('subscription-required', { plan: 'free' })
    } else {
      mainWindow?.webContents.send('error', { message: 'Ошибка подключения к серверу' })
    }
  }
}

// =============================================================
// IPC handlers (renderer <-> main)
// =============================================================
ipcMain.handle('get-user', () => {
  if (!tokenStore.isLoggedIn()) return null
  return tokenStore.getUser()
})

ipcMain.handle('logout', async () => {
  tokenStore.clear()
  // Полная очистка всех сессий и кук
  await session.defaultSession.clearStorageData({
    storages: ['cookies','localstorage','indexdb','cachestorage','serviceworkers']
  })
  // Очищаем также partition игр
  const gameSess = session.fromPartition('persist:game')
  await gameSess.clearStorageData()
  await gameSess.clearCache()
  // Закрываем все окна
  mainWindow?.close()
  gameWindow?.close()
  // Открываем окно входа с чистой сессией
  createAuthWindow()
})

ipcMain.handle('launch-game', async (_event, { gameSlug, roomId }: { gameSlug: string; roomId: string }) => {
  await verifyAndLaunchGame(gameSlug, roomId)
})

ipcMain.handle('close-game', () => {
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.close()
  }
})

ipcMain.handle('open-browser', (_event, url: string) => {
  shell.openExternal(url)
})

// =============================================================
// Deep link обработка: mazalive://launch?game=slug&room=id
// =============================================================
function handleDeepLink(url: string) {
  const parsed = new URL(url)
  if (parsed.hostname === 'launch') {
    const gameSlug = parsed.searchParams.get('game')
    const roomId = parsed.searchParams.get('room')
    if (gameSlug && roomId) {
      verifyAndLaunchGame(gameSlug, roomId)
    }
  }
}

// Windows/Linux: deep link через second-instance
app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const deepLinkUrl = argv.find((arg) => arg.startsWith('mazalive://'))
  if (deepLinkUrl) handleDeepLink(deepLinkUrl)
})

// macOS: deep link через open-url
app.on('open-url', (_event, url) => {
  handleDeepLink(url)
})

// =============================================================
// App lifecycle
// =============================================================
app.whenReady().then(() => {
  // 🚫 ГЛОБАЛЬНО убираем меню приложения (Файл/Правка/Вид...).
  // setMenu(null) на окне ненадёжен на Windows (Alt показывает меню), поэтому
  // снимаем меню на уровне всего приложения — это работает во ВСЕХ окнах.
  Menu.setApplicationMenu(null)

  // Проверяем, залогинен ли пользователь
  if (tokenStore.isLoggedIn()) {
    createMainWindow()
  } else {
    createAuthWindow()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (tokenStore.isLoggedIn()) createMainWindow()
      else createAuthWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// =============================================================
// АВТО-ОБНОВЛЕНИЕ (electron-updater, провайдер generic)
// Проверяем обновление при старте + по IPC-запросу из renderer.
// Пользователю показываем нативное окно: «Доступно обновление» → Обновить.
// =============================================================
autoUpdater.autoDownload = false          // не качаем молча — спрашиваем
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = null

function checkForUpdates(interactive = false) {
  // Авто-обновление не работает в dev-режиме
  if (DEV) {
    if (interactive) dialog.showMessageBox({ message: 'Обновления отключены в режиме разработки' })
    return
  }
  autoUpdater.checkForUpdates().catch((err) => {
    console.log('[Updater] check failed:', err?.message)
    if (interactive) {
      dialog.showMessageBox(mainWindow ?? undefined as any, {
        type: 'info',
        title: 'Обновление',
        message: 'Не удалось проверить обновления. Проверьте интернет.',
      })
    }
  })
}

autoUpdater.on('update-available', (info) => {
  dialog
    .showMessageBox(mainWindow ?? undefined as any, {
      type: 'info',
      title: 'Доступно обновление',
      message: `Вышла новая версия Mazlive ${info.version}`,
      detail: `У вас установлена ${APP_VERSION}. Обновить сейчас? Приложение загрузит новую версию и перезапустится.`,
      buttons: ['Обновить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    })
    .then((res) => {
      if (res.response === 0) {
        autoUpdater.downloadUpdate().catch(() => {})
      }
    })
})

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] already up to date:', APP_VERSION)
})

autoUpdater.on('download-progress', (p) => {
  mainWindow?.webContents.send('update-progress', { percent: Math.round(p.percent) })
})

autoUpdater.on('update-downloaded', (info) => {
  dialog
    .showMessageBox(mainWindow ?? undefined as any, {
      type: 'info',
      title: 'Обновление готово',
      message: `Mazlive ${info.version} загружено`,
      detail: 'Перезапустить приложение сейчас, чтобы применить обновление?',
      buttons: ['Перезапустить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
    })
    .then((res) => {
      if (res.response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall())
      }
    })
})

autoUpdater.on('error', (err) => {
  console.log('[Updater] error:', err?.message)
})

// Ручной запрос проверки из renderer (кнопка «Проверить обновления»)
ipcMain.handle('check-updates', () => {
  checkForUpdates(true)
  return APP_VERSION
})

// Проверяем обновление через 5 сек после старта (не тормозим запуск)
app.whenReady().then(() => {
  setTimeout(() => checkForUpdates(false), 5000)
})
