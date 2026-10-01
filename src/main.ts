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
import fs from 'node:fs'
import axios from 'axios'
import { autoUpdater } from 'electron-updater'
import { tokenStore } from './auth/tokenStore'
import { isDesktopGame, requiresDesktopAgent } from './games/registry'
import {
  autoDetectGta,
  findGtaInDir,
  checkDependencies,
  installMod,
  uninstallMod,
  launchGta,
  isGtaRunning,
} from './gta/gtaMod'
// @ts-ignore — .mjs адаптер мода (переиспользуем как есть)
import { GtaAgent } from '../agent/gta-agent.mjs'

const APP_VERSION = app.getVersion()

const WEB_URL = process.env.WEB_URL || 'https://mazlive.com'
const GAME_SERVER_URL = process.env.GAME_SERVER_URL || 'https://games.mazlive.com'
const GAME_SERVER_SOCKET_URL = process.env.GAME_SERVER_SOCKET_URL || 'https://games.mazlive.com/viewer'
const DEV = process.env.NODE_ENV === 'development'

let authWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let gameWindow: BrowserWindow | null = null

// ─── GTA desktop-game runtime ───
let gtaAgent: GtaAgent | null = null
let gtaState: {
  gamePath: string | null
  modInstalled: boolean
  agentRunning: boolean
  lastStatus: string
  lastError: string | null
} = { gamePath: null, modInstalled: false, agentRunning: false, lastStatus: 'idle', lastError: null }

// Папка с упакованными ресурсами мода (в prod — resources/mod, в dev — ./mod)
function modSourceDir(): string {
  const packaged = path.join(process.resourcesPath || '', 'mod')
  if (fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'mod')
}

// Динамическая загрузка socket.io-client (упакован в Electron, юзеру Node не нужен)
function loadSocketIo() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('socket.io-client').io
}

function sendToMain(channel: string, payload?: any) {
  mainWindow?.webContents.send(channel, payload)
}

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
      // ✅ Роутинг по типу игры (по умолчанию — web-game, обратная совместимость)
      if (isDesktopGame(gameSlug)) {
        await startDesktopGame(gameSlug, roomId, res.data.roomToken, res.data)
      } else {
        await createGameWindow(gameSlug, roomId, res.data.roomToken)
      }
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
// DESKTOP-GAME: запуск локальной игры (GTA «Царь горы»)
// =============================================================
async function startDesktopGame(gameSlug: string, roomId: string, roomToken: string, user: any) {
  gtaState.lastError = null
  const needAgent = requiresDesktopAgent(gameSlug)

  // 1) Проверяем наличие GTA
  let gamePath = gtaState.gamePath
  if (!gamePath || !findGtaInDir(gamePath)) {
    const found = autoDetectGta()
    gamePath = found?.gamePath || null
    gtaState.gamePath = gamePath
  }
  if (!gamePath) {
    sendToMain('gta-required', { stage: 'gta-missing', message: 'GTA V Legacy не найдена — укажите папку игры.' })
    return
  }

  // 2) Проверяем зависимости и мод
  const dep = checkDependencies(gamePath)
  const modInstalled = fs.existsSync(path.join(gamePath, 'scripts', 'MazLiveKOTH.dll'))
  gtaState.modInstalled = modInstalled
  if (!dep.ok || !modInstalled) {
    sendToMain('gta-required', {
      stage: !dep.ok ? 'deps-missing' : 'mod-missing',
      message: 'Требуется установка мода / зависимостей.',
      missing: dep.missing,
      gamePath,
    })
    return
  }

  // 3) Проверяем, не запущена ли уже GTA
  if (await isGtaRunning()) {
    sendToMain('gta-required', { stage: 'gta-running', message: 'GTA уже запущена. Закройте игру и попробуйте снова.' })
    return
  }

  // 4) Запускаем агент (если нужен)
  if (needAgent) {
    try {
      startAgent(gamePath, roomId, roomToken, user)
    } catch (e: any) {
      sendToMain('gta-status', { kind: 'error', message: 'Не удалось запустить агент: ' + e.message })
      return
    }
  }

  // 5) Запускаем GTA V Legacy (Story Mode, без Online)
  try {
    launchGta(gamePath)
  } catch (e: any) {
    sendToMain('gta-status', { kind: 'error', message: 'Не удалось запустить GTA: ' + e.message })
    return
  }

  // 6) Открываем панель управления GTA (локальная панель внутри Electron)
  createGtaPanelWindow(gamePath, roomId)
}

function startAgent(gamePath: string, roomId: string, roomToken: string, user: any) {
  // Останавливаем предыдущий агент
  if (gtaAgent) { try { gtaAgent.disconnect() } catch {} gtaAgent = null }

  gtaAgent = new GtaAgent({ gamePath, deps: { loadSocketIo } })
  gtaAgent.on('status', (s: any) => {
    gtaState.lastStatus = s.kind
    sendToMain('gta-agent-status', s)
  })
  gtaAgent.on('command', (c: any) => sendToMain('gta-command', c))
  gtaAgent.on('ack', (a: any) => sendToMain('gta-ack', a))

  // ⚠️ Токен передаём ТОЛЬКО в память агента, никогда не сохраняем на диск.
  gtaAgent.connect({
    room: roomId,
    token: roomToken,
    nickname: user?.name || roomId,
    gameSlug: 'gta-koth',
    serverUrl: GAME_SERVER_SOCKET_URL,
  }).then(() => {
    gtaState.agentRunning = true
    sendToMain('gta-agent-status', { kind: 'agent_started', message: 'Агент запущен' })
  }).catch((e: any) => {
    sendToMain('gta-agent-status', { kind: 'error', message: 'Ошибка агента: ' + e.message })
  })
}

function createGtaPanelWindow(gamePath: string, roomId: string) {
  if (gameWindow && !gameWindow.isDestroyed()) gameWindow.close()
  gameWindow = new BrowserWindow({
    width: 640,
    height: 560,
    title: 'Mazlive — Панель GTA (Царь горы)',
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: DEV,
    },
  })
  gameWindow.setMenu(null)
  gameWindow.setMenuBarVisibility(false)
  const q = new URLSearchParams({ gamePath, roomId })
  gameWindow.loadFile(path.join(__dirname, '..', 'renderer', 'gta-panel.html'), { search: '?' + q.toString() })
  gameWindow.on('closed', () => { gameWindow = null })
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

// ─── DESKTOP-GAME (GTA) IPC ───
ipcMain.handle('gta-detect', () => {
  const found = autoDetectGta()
  if (found) gtaState.gamePath = found.gamePath
  const dep = found ? checkDependencies(found.gamePath) : null
  const modInstalled = found ? fs.existsSync(path.join(found.gamePath, 'scripts', 'MazLiveKOTH.dll')) : false
  gtaState.modInstalled = modInstalled
  return {
    found: !!found,
    gamePath: found?.gamePath || null,
    deps: dep,
    modInstalled,
  }
})

ipcMain.handle('gta-check-path', (_event, { gamePath }: { gamePath: string }) => {
  // ✅ Валидация пути: принимаем только реальный путь к существующей папке с GTA5.exe
  const hit = findGtaInDir(String(gamePath || ''))
  if (!hit) return { ok: false, error: 'GTA5.exe не найден по этому пути' }
  gtaState.gamePath = hit.gamePath
  const dep = checkDependencies(hit.gamePath)
  const modInstalled = fs.existsSync(path.join(hit.gamePath, 'scripts', 'MazLiveKOTH.dll'))
  gtaState.modInstalled = modInstalled
  return { ok: true, gamePath: hit.gamePath, deps: dep, modInstalled }
})

ipcMain.handle('gta-install-mod', async (_event, { gamePath }: { gamePath: string }) => {
  const gp = gamePath && findGtaInDir(String(gamePath)) ? findGtaInDir(String(gamePath))!.gamePath : gtaState.gamePath
  if (!gp) throw new Error('GTA не найдена')
  if (await isGtaRunning()) throw new Error('Закройте GTA перед установкой мода')
  const res = installMod(gp, modSourceDir())
  gtaState.gamePath = gp
  gtaState.modInstalled = true
  return res
})

ipcMain.handle('gta-uninstall-mod', async (_event, { gamePath }: { gamePath: string }) => {
  const gp = gamePath && findGtaInDir(String(gamePath)) ? findGtaInDir(String(gamePath))!.gamePath : gtaState.gamePath
  if (!gp) throw new Error('GTA не найдена')
  if (await isGtaRunning()) throw new Error('Закройте GTA перед удалением мода')
  const res = uninstallMod(gp, modSourceDir())
  gtaState.modInstalled = false
  return res
})

ipcMain.handle('gta-state', () => {
  let mod: any = null
  if (gtaAgent) { try { mod = gtaAgent.state() } catch (e: any) { mod = { error: e.message } } }
  return { ...gtaState, agent: mod }
})

ipcMain.handle('gta-agent-command', (_event, { action, count = 1 }: { action: string; count?: number }) => {
  if (!gtaAgent) throw new Error('Агент не запущен')
  return gtaAgent.control(action, { count, name: 'Streamer' })
})

ipcMain.handle('gta-agent-stop', () => {
  if (gtaAgent) { gtaAgent.disconnect(); gtaAgent = null }
  gtaState.agentRunning = false
  return { ok: true }
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
  if (gtaAgent) { try { gtaAgent.disconnect() } catch {} gtaAgent = null }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (gtaAgent) { try { gtaAgent.disconnect() } catch {} gtaAgent = null }
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
