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
// electron-updater грузим ЛЕНИВО (require) и в try/catch: его геттер autoUpdater
// бросает при невалидной версии приложения, и это уронило бы весь main-процесс.
// В упакованном виде версия валидна, но защищаемся от любых сбоев апдейтера.
import { tokenStore } from './auth/tokenStore'
import { isDesktopGame, requiresDesktopAgent, gameWebPath, gameFullscreen } from './games/registry'
import { gtaSettings, MOD_ACTIONS } from './settings/gtaSettings'
import {
  autoDetectGta,
  findGtaInDir,
  checkDependencies,
  installMod,
  uninstallMod,
  launchGta,
  isGtaRunning,
} from './gta/gtaMod'
// Агент (ESM .mjs) грузится ЛЕНИВО через CJS-обёртку с нативным import().
// Нельзя делать статический import '../agent/gta-agent.mjs': TS превратит его в
// require() → ERR_REQUIRE_ESM в упакованном Electron. См. agent/load-agent.js.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadAgent } = require('../agent/load-agent.js') as {
  loadAgent: () => Promise<{ GtaAgent: any }>
}

const APP_VERSION = app.getVersion()

// ── ИЗОЛЯЦИЯ БЕТЫ ОТ СТАБИЛЬНОГО ПРИЛОЖЕНИЯ ──
// Стабильное: name "Mazlive", userData %APPDATA%\Mazlive, appId com.mazalive.desktop
// Бета:       name "Mazlive Desktop 2", userData %APPDATA%\Mazlive Desktop 2
// Явно фиксируем appName → electron-store/сессия НЕ пересекаются со стабильной версией,
// даже если productName/package name когда-то совпадут.
app.setName('Mazlive Desktop 2')

const WEB_URL = process.env.WEB_URL || 'https://mazlive.com'
const GAME_SERVER_URL = process.env.GAME_SERVER_URL || 'https://games.mazlive.com'
const GAME_SERVER_SOCKET_URL = process.env.GAME_SERVER_SOCKET_URL || 'https://games.mazlive.com/viewer'
const DEV = process.env.NODE_ENV === 'development'

let authWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let gameWindow: BrowserWindow | null = null

// ─── GTA desktop-game runtime ───
let gtaAgent: any | null = null
let gtaRefreshTimer: ReturnType<typeof setInterval> | null = null
let gtaPanelOpen = false
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

/**
 * Записывает настройки раунда/трассы в scripts/MazLiveKOTH/settings.ini установленного мода.
 * Возвращает путь к записанному файлу или null, если мод/папка недоступны.
 * ПРИМЕЧАНИЕ: применяется на следующем рестарте раунда в GTA (F10/F7), как описано в моде.
 */
function applyCourseSettingsToMod(gamePath: string | null): string | null {
  if (!gamePath) return null
  const kothDir = path.join(gamePath, 'scripts', 'MazLiveKOTH')
  if (!fs.existsSync(kothDir)) return null
  const s = gtaSettings.get()
  const ini =
    '[Course]\n' +
    '; Slope: 8-28 degrees. Restart course with F10 / F7 after editing.\n' +
    `Angle = ${s.course.angle}\n` +
    '; 6-24 segments, actual meters depend on GTA model dimensions.\n' +
    `Segments = ${s.course.segments}\n` +
    `RoundSeconds = ${s.course.roundSeconds}\n`
  const dest = path.join(kothDir, 'settings.ini')
  fs.writeFileSync(dest, ini, 'utf8')
  return dest
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

  // ─── BETA.14: GTA-карточка приходит с production-сайта (каталог) ───
  // DOM-инъекция удалена: карточка gta-koth (data-game-slug="gta-koth")
  // рендерится сайтом, а её кнопка «Запустить» внутри Electron вызывает
  // window.mazalive.gta.openPanel() (см. handleLaunchDesktop в GameCard).
  // Дуального источника карточки больше нет — ровно ОДНА карточка GTA.

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
  const customPath = gameWebPath(gameSlug)
  const isFullscreen = gameFullscreen(gameSlug)
  const gameUrl = customPath
    ? `${GAME_SERVER_URL}${customPath}?room=${roomId}&token=${encodeURIComponent(roomToken)}&lang=${lang}`
    : `${GAME_SERVER_URL}/games/${gameSlug}?room=${roomId}&token=${encodeURIComponent(roomToken)}&lang=${lang}`
  gameWindow.loadURL(gameUrl)
  if (isFullscreen) gameWindow.setFullScreen(true)

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
// Ищем cookie сессии Auth.js среди всех источников (defaultSession + все сессии окон).
async function findSessionCookie(): Promise<string | null> {
  const names = ['authjs.session-token', '__Secure-authjs.session-token']
  try {
    const urls = [WEB_URL, `${WEB_URL}/dashboard`, `${WEB_URL}/login`]
    for (const u of urls) {
      const cookies = await session.defaultSession.cookies.get({ url: u })
      const hit = cookies.find((c) => names.includes(c.name))
      if (hit?.value) return hit.value
    }
    // На всякий случай — без url-фильтра
    const all = await session.defaultSession.cookies.get({})
    const hit = all.find((c) => names.includes(c.name))
    if (hit?.value) return hit.value
  } catch (e) {}
  // Фолбэк: сессия конкретного окна (главное окно = прод-кабинет, там уже залогинены)
  try {
    const ses = mainWindow?.webContents.session
    if (ses) {
      const cookies = await ses.cookies.get({})
      const hit = cookies.find((c) => names.includes(c.name))
      if (hit?.value) return hit.value
    }
  } catch (e) {}
  return null
}

async function captureSessionFromCookies(): Promise<string | null> {
  try {
    // Получаем cookie сессии из WebView (defaultSession + окна)
    const tokenValue = await findSessionCookie()
    if (!tokenValue) return null

    // Проверяем токен на сервере
    const res = await axios.get(`${WEB_URL}/api/auth/verify-subscription`, {
      headers: { Authorization: `Bearer ${tokenValue}` },
    })

    if (res.data.valid) {
      // Сохраняем данные авторизации
      const user = res.data
      tokenStore.save({
        sessionToken: tokenValue,
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
      return tokenValue
    }
    return null
  } catch (err) {
    console.error('[Auth] Failed to capture session:', err)
    return null
  }
}

// Возвращает рабочий токен: из store, а если его нет — восстанавливает из cookies.
// Нужно, т.к. главное окно = прод-кабинет с живой сессией в куках,
// но tokenStore мог не сохраниться (первый запуск / сброс store).
async function resolveToken(): Promise<string | null> {
  const stored = tokenStore.getToken()
  if (stored) return stored
  return await captureSessionFromCookies()
}

// =============================================================
// Проверка подписки перед запуском игры
// =============================================================
async function verifyAndLaunchGame(gameSlug: string, roomId: string) {
  const token = await resolveToken()
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
    // Открываем панель онбординга, чтобы стример выбрал папку/поставил мод не выходя из приложения.
    openGtaPanelWindow(null, roomId)
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
    // Открываем панель онбординга (проверка зависимостей / установка мода).
    openGtaPanelWindow(gamePath, roomId)
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
      await startAgent(gamePath, roomId, roomToken, user)
    } catch (e: any) {
      sendToMain('gta-status', { kind: 'error', message: 'Не удалось запустить агент: ' + e.message })
      sendToMain('gta-agent-status', { kind: 'error', message: 'Агент недоступен: ' + e.message })
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

async function startAgent(gamePath: string, roomId: string, roomToken: string, user: any) {
  // Останавливаем предыдущий агент
  if (gtaAgent) { try { gtaAgent.disconnect() } catch {} gtaAgent = null }
  if (gtaRefreshTimer) { clearInterval(gtaRefreshTimer); gtaRefreshTimer = null }

  // ЛЕНИВАЯ загрузка ESM-агента через CJS-обёртку (нативный import()).
  // Если модуль недоступен — бросаем наверх, НЕ блокируя вход и web-игры.
  const { GtaAgent } = await loadAgent()

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

  // Токен живёт 15 мин → обновляем каждые 12 мин, иначе /streamer отвалится.
  gtaRefreshTimer = setInterval(async () => {
    try {
      const tk = tokenStore.getToken()
      if (!tk || !gtaAgent) return
      const r = await axios.get(`${WEB_URL}/api/auth/verify-subscription`, {
        headers: { Authorization: `Bearer ${tk}` },
        timeout: 15000,
      })
      if (r.data?.valid && r.data?.roomToken) gtaAgent.refreshToken(r.data.roomToken)
    } catch { /* реконнект сам повторит */ }
  }, 12 * 60 * 1000)
}

/**
 * Открывает локальную панель GTA «Царь горы».
 * ВАЖНО: панель открывается ДАЖЕ БЕЗ установленной GTA (gamePath=null) —
 * тогда панель показывает онбординг: поиск/выбор папки, зависимости, установку мода.
 * roomId может быть пустым (запуск из каталога до создания игровой сессии).
 */
function openGtaPanelWindow(gamePath: string | null, roomId: string, roomToken = '') {
  // Панель открывается В ТОМ ЖЕ (главном) окне — без второго окна. Кнопка «Назад» вернёт на кабинет.
  const w = mainWindow
  if (!w || w.isDestroyed()) return
  gtaPanelOpen = true
  // roomToken передаём в панель отдельным query-параметром (живёт только в памяти окна).
  const q = new URLSearchParams({ gamePath: gamePath || '', roomId: roomId || '', roomToken: roomToken || '' })
  w.loadFile(path.join(__dirname, '..', 'renderer', 'gta-panel.html'), { search: '?' + q.toString() })
}

/** Вернуться из панели мода в кабинет (главное окно). */
function backToDashboard() {
  gtaPanelOpen = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(WEB_URL + '/dashboard')
  }
}

/** Ник TikTok из дашборда (cookie tiktok_username). Пусто — эфир не настроен. */
async function getTikTokUsername(): Promise<string> {
  try {
    for (const sess of [session.defaultSession, session.fromPartition('persist:game')]) {
      const cookies = await sess.cookies.get({ name: 'tiktok_username' })
      const v = cookies?.[0]?.value
      if (v) return String(v).replace('@', '').trim().toLowerCase()
    }
    const all = await session.defaultSession.cookies.get({ url: WEB_URL })
    const c = all.find((x) => x.name === 'tiktok_username')
    if (c?.value) return String(c.value).replace('@', '').trim().toLowerCase()
  } catch { /* нет cookie — эфир не подключён */ }
  return ''
}

// Обратная совместимость: старое имя (панель после запуска GTA).
function createGtaPanelWindow(gamePath: string, roomId: string) {
  openGtaPanelWindow(gamePath, roomId)
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

ipcMain.handle('gta-test-event', (_event, { evt }: { evt: any }) => {
  if (!gtaAgent) throw new Error('Агент не запущен — сначала «Подключить эфир»')
  return gtaAgent.simulate(evt)
})

ipcMain.handle('gta-agent-stop', () => {
  if (gtaAgent) { gtaAgent.disconnect(); gtaAgent = null }
  gtaState.agentRunning = false
  return { ok: true }
})

ipcMain.handle('gta-get-username', async () => {
  const username = await getTikTokUsername()
  return { username, agentRunning: gtaState.agentRunning, streamLive: !!gtaAgent?.streamLive }
})

// Возврат из панели мода в кабинет (панель открыта в главном окне)
ipcMain.handle('gta-back', () => {
  // Агент продолжает работать (эфир идёт) — просто возвращаемся в кабинет.
  backToDashboard()
  return { ok: true }
})

// Полное закрытие панели: остановить агент и вернуться
ipcMain.handle('gta-close-panel', () => {
  if (gtaAgent) { try { gtaAgent.disconnect() } catch {} gtaAgent = null }
  gtaState.agentRunning = false
  backToDashboard()
  return { ok: true }
})

// ─── Подключение эфира ИЗ ПАНЕЛИ (ник → комната → агент) ───
// Аналог «Подключить стрим» из дашборда, но для мода: агент сам поднимет /streamer
// (open_room + start_tiktok) и /viewer (join_room). Токен берём свежий с сервера.
ipcMain.handle('gta-connect-stream', async (_e, { username, gamePath }: { username?: string; gamePath?: string }) => {
  const token = tokenStore.getToken()
  if (!token) { await showGtaModal('auth'); return { ok: false, reason: 'auth' } }
  try {
    const res = await axios.get(`${WEB_URL}/api/auth/verify-subscription`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
    })
    if (!(res.data?.valid && res.data?.plan === 'pro')) {
      await showGtaModal('sub'); return { ok: false, reason: 'subscription' }
    }
    const room = String(username || (await getTikTokUsername()) || '').replace('@', '').trim().toLowerCase()
    if (!room) return { ok: false, reason: 'no_username' }

    // Проверяем мод и GTA
    const gp = gamePath || gtaState.gamePath
    if (!gp || !findGtaInDir(gp)) return { ok: false, reason: 'gta-missing' }
    const modOk = fs.existsSync(path.join(gp, 'scripts', 'MazLiveKOTH.dll'))
    if (!modOk) return { ok: false, reason: 'mod-missing' }

    await startAgent(gp, room, res.data.roomToken, { name: room })
    // запомним ник, чтобы карточка/панель знали комнату
    try { await session.defaultSession.cookies.set({ url: WEB_URL, name: 'tiktok_username', value: room, path: '/' }) } catch {}
    return { ok: true, room }
  } catch (err: any) {
    if (err?.response?.status === 401) { tokenStore.clear(); await showGtaModal('auth'); return { ok: false, reason: 'auth' } }
    if (err?.response?.status === 403) { await showGtaModal('sub'); return { ok: false, reason: 'subscription' } }
    return { ok: false, reason: 'error', error: 'Ошибка подключения к серверу' }
  }
})

// ─── Открытие локальной панели GTA без установленной игры ───
// Мод доступен только по общей PRO-подписке (как остальные игры MAZLIVE).
// Проверяем подписку на сервере ДО открытия панели; при отказе — нативный диалог.
ipcMain.handle('gta-open-panel', async () => {
  const token = await resolveToken()
  if (!token) {
    mainWindow?.webContents.send('auth-required')
    await showGtaModal('auth')
    return { ok: false, reason: 'auth' }
  }
  try {
    const res = await axios.get(`${WEB_URL}/api/auth/verify-subscription`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    })
    if (res.data?.valid && res.data?.plan === 'pro') {
      // Ник TikTok (введён в дашборде) = комната эфира. Как у всех игр.
      const username = await getTikTokUsername()
      const roomToken = res.data?.roomToken || ''
      // Панель сразу с полным набором: комната + токен (панель сама поднимет /streamer).
      openGtaPanelWindow(gtaState.gamePath, username, roomToken)
      return { ok: true, gamePath: gtaState.gamePath, room: username, hasStream: !!username }
    }
    await showGtaModal('sub')
    return { ok: false, reason: 'subscription', plan: res.data?.plan || 'free' }
  } catch (err: any) {
    if (err?.response?.status === 401) {
      tokenStore.clear()
      mainWindow?.webContents.send('auth-required')
      await showGtaModal('auth')
      return { ok: false, reason: 'auth' }
    }
    if (err?.response?.status === 403) {
      await showGtaModal('sub')
      return { ok: false, reason: 'subscription', plan: 'free' }
    }
    return { ok: false, reason: 'error', error: 'Ошибка подключения к серверу' }
  }
})

// ─── Нативный диалог доступа к моду (подписка/вход) ───
// В бете главное окно показывает прод-кабинет, который НЕ слушает IPC
// subscription-required / auth-required — поэтому показываем диалог сами.
async function showGtaModal(kind: 'sub' | 'auth') {
  const isSub = kind === 'sub'
  const { response } = await dialog.showMessageBox(mainWindow ?? undefined as any, {
    type: 'info',
    title: isSub ? 'Нужна подписка PRO' : 'Нужно войти',
    message: isSub
      ? 'Игра «GTA V — Царь горы» доступна по подписке PRO.'
      : 'Чтобы запустить игру, войдите в аккаунт MAZLIVE.',
    detail: isSub
      ? 'Оформите подписку PRO в личном кабинете (Профиль → «Получить Pro») — после оплаты игра станет доступна в этом приложении.'
      : 'Нажмите «Войти», чтобы авторизоваться в браузере, затем вернитесь в приложение.',
    buttons: isSub ? ['Оформить подписку', 'Позже'] : ['Войти', 'Позже'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) {
    shell.openExternal(isSub ? `${WEB_URL}/profile` : `${WEB_URL}/login?from=electron`)
  }
}

// ─── Выбор папки игры через нативный диалог ───
ipcMain.handle('gta-select-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow ?? undefined as any, {
    title: 'Выберите папку с GTA V (где лежит GTA5.exe)',
    properties: ['openDirectory'],
  })
  if (res.canceled || !res.filePaths.length) return { ok: false }
  const dir = res.filePaths[0]
  const hit = findGtaInDir(dir)
  if (!hit) return { ok: false, error: 'GTA5.exe не найден по этому пути' }
  gtaState.gamePath = hit.gamePath
  const deps = checkDependencies(hit.gamePath)
  const modInstalled = fs.existsSync(path.join(hit.gamePath, 'scripts', 'MazLiveKOTH.dll'))
  gtaState.modInstalled = modInstalled
  return { ok: true, gamePath: hit.gamePath, deps, modInstalled }
})

// ─── Каталог подарков TikTok (для выбора правила в панели GTA) ───
// Грузим ТОТ ЖЕ каталог, что и остальные игры MAZLIVE: /data/gifts.json с прода.
// Иконки рендер отдаёт через /api/avatar-прокси (как в других играх). Кэшируем в памяти.
let giftsCache: { id: number; name: string; coins: number; image_url?: string }[] | null = null
ipcMain.handle('gta-gifts-catalog', async () => {
  if (giftsCache) return { ok: true, gifts: giftsCache }
  try {
    const cookies = await session.defaultSession.cookies.get({ url: WEB_URL })
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const res = await axios.get(`${WEB_URL}/data/gifts.json`, {
      headers: { Cookie: cookieHeader },
      timeout: 15000,
    })
    const data = res.data || {}
    const list = (data.gifts || data || []).map((g: any) => ({
      id: g.id, name: g.name, coins: g.coins, image_url: g.image_url,
    }))
    giftsCache = list
    return { ok: true, gifts: list }
  } catch (e: any) {
    return { ok: false, error: e.message, gifts: [] }
  }
})

// ─── Настройки GTA (реакции + раунд/трасса) ───
ipcMain.handle('gta-settings-get', () => {
  return { ok: true, settings: gtaSettings.get(), actions: MOD_ACTIONS }
})

ipcMain.handle('gta-settings-set', (_event, { settings }: { settings: any }) => {
  const saved = gtaSettings.set(settings || {})
  // Если мод установлен — сразу применяем курс в settings.ini
  let applied: string | null = null
  try { applied = applyCourseSettingsToMod(gtaState.gamePath) } catch { applied = null }
  return { ok: true, settings: saved, applied }
})

ipcMain.handle('gta-settings-reset', () => {
  const saved = gtaSettings.reset()
  try { applyCourseSettingsToMod(gtaState.gamePath) } catch { /* ignore */ }
  return { ok: true, settings: saved }
})

ipcMain.handle('gta-apply-course', (_event, { gamePath }: { gamePath?: string }) => {
  const gp = gamePath && findGtaInDir(String(gamePath)) ? findGtaInDir(String(gamePath))!.gamePath : gtaState.gamePath
  const applied = applyCourseSettingsToMod(gp)
  return { ok: !!applied, applied, gamePath: gp }
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
// ВАЖНО: загрузка и init обёрнуты в try/catch — сбой апдейтера НЕ должен
// ронять main-процесс (был кейс: невалидная версия → падение на старте).
// =============================================================
let autoUpdater: any = null

function initUpdater(): boolean {
  if (autoUpdater) return true
  if (DEV) return false // в dev-режиме авто-обновление не работает
  try {
    // Ленивый require: геттер autoUpdater бросает при невалидной версии.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.autoDownload = false          // не качаем молча — спрашиваем
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null

    autoUpdater.on('update-available', (info: any) => {
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

    autoUpdater.on('download-progress', (p: any) => {
      mainWindow?.webContents.send('update-progress', { percent: Math.round(p.percent) })
    })

    autoUpdater.on('update-downloaded', (info: any) => {
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

    autoUpdater.on('error', (err: any) => {
      console.log('[Updater] error:', err?.message)
    })
    return true
  } catch (err: any) {
    console.log('[Updater] недоступен:', err?.message)
    autoUpdater = null
    return false
  }
}

function checkForUpdates(interactive = false) {
  if (DEV) {
    if (interactive) dialog.showMessageBox({ message: 'Обновления отключены в режиме разработки' })
    return
  }
  if (!initUpdater()) {
    if (interactive) {
      dialog.showMessageBox(mainWindow ?? undefined as any, {
        type: 'info',
        title: 'Обновление',
        message: 'Авто-обновление недоступно в этой сборке.',
      })
    }
    return
  }
  autoUpdater.checkForUpdates().catch((err: any) => {
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

// Ручной запрос проверки из renderer (кнопка «Проверить обновления»)
ipcMain.handle('check-updates', () => {
  checkForUpdates(true)
  return APP_VERSION
})

// Проверяем обновление через 5 сек после старта (не тормозим запуск)
app.whenReady().then(() => {
  setTimeout(() => checkForUpdates(false), 5000)
})
