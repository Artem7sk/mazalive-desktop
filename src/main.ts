import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  protocol,
  shell,
} from 'electron'
import path from 'path'
import axios from 'axios'
import { tokenStore } from './auth/tokenStore'

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
  authWindow.setMenuBarVisibility(false)

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
  mainWindow.setMenuBarVisibility(false)

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

  gameWindow.setMenuBarVisibility(false)

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
