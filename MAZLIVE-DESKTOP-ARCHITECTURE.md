# Mazlive Desktop 2.0 — Архитектура

## Обзор

Mazlive Desktop 2.0 — Electron-приложение (TypeScript). Сохраняет исходную трёхоконную модель
и добавляет поддержку локальных desktop-игр через **агент** и **мод**.

```
┌─────────────────────────── Electron (main) ───────────────────────────┐
│                                                                       │
│  Auth window ── login на mazlive.com ──> captureSessionFromCookies     │
│                                                                       │
│  Main window (dashboard)                                              │
│     │  window.mazalive.launchGame(slug, room)                         │
│     ▼                                                                  │
│  verifyAndLaunchGame ── /api/auth/verify-subscription                 │
│     │                                                                  │
│     ├── type=web-game ──────> createGameWindow(slug, room, token)      │
│     │                          games.mazlive.com/games/<slug>?room=…   │
│     │                                                                  │
│     └── type=desktop-game ──> startDesktopGame(gta-koth, …)           │
│            ├── findGta / checkDependencies / isGtaRunning              │
│            ├── GtaAgent.connect({room, token(в памяти), …})           │
│            │      │ socket.io /viewer  ── join_room                    │
│            │      ▼                                                    │
│            │   tiktok_reaction ── Router.accept() ── ModBridge.send()  │
│            │                                          │ (файловый мост)│
│            │                                          ▼                │
│            │                       <GTA>/scripts/MazLiveKOTH/inbox/*.cmd
│            ├── launchGta (Story Mode, -scOfflineOnly)                  │
│            └── createGtaPanelWindow (локальная панель)                 │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌────────── GTA V Legacy ──────────┐
                    │  MazLiveKOTH.dll (SHVDN)         │
                    │   читает inbox/*.cmd             │
                    │   пишет status.json, acks/*.json │
                    └──────────────────────────────────┘
```

## Компоненты

### 1. Реестр игр — `src/games/registry.ts`
- Поле `type: 'web-game' | 'desktop-game'`.
- `resolveType()` — обратная совместимость: нет `type` → `web-game`.
- `isDesktopGame(slug)`, `requiresDesktopAgent(slug)`.

### 2. Агент — `agent/`
- `bridge.mjs` — файловый мост к моду (переиспользуется из пакета мода, проверен тестами).
- `rules.mjs` — правила событие→действие (**исправлена дедупликация** под реальный payload game-server).
- `gta-agent.mjs` — ядро: Socket.IO-клиент (`/viewer`, `join_room`), очередь, дедуп, лимиты, реконнект, ACK.
- Работает **внутри main-процесса Electron**. Отдельного HTTP-сервера НЕТ — панель общается по узкому IPC/preload.

### 3. Менеджер мода — `src/gta/gtaMod.ts`
- Поиск GTA (`autoDetectGta`, `findGtaInDir`).
- Проверка зависимостей (`checkDependencies`).
- Установка (`installMod`) — с бэкапами и маркером `.mazlive-install.json`.
- Удаление (`uninstallMod`) — только файлы MAZLIVE, конфликты не трогает.
- Запуск (`launchGta`) — только Story Mode (`-scOfflineOnly`).

### 4. Панель — `renderer/gta-panel.html`
Локальная панель стримера: статусы, счётчики, кнопки управления (старт/стоп/очистить/сброс), журнал.

### 5. Мост к моду — протокол v2
`<GTA>/scripts/MazLiveKOTH/`
- `status.json` — состояние мода (phase, progress, wins, falls, queue, objects, version, session).
- `inbox/*.cmd` — команды (TAB-separated, атомарная запись). Лимит 100 в очереди.
- `acks/<id>.json` — подтверждения.
- `backups/` — резервные копии.

## Безопасность

- **JWT только в памяти**, никогда на диск/логи/аргументы.
- Пути к файлам валидируются (принимается только папка с `GTA5.exe`).
- Мод только для **Story Mode**; запуск с `-scOfflineOnly`.
- Бэкапы перед установкой; умный удалятор.
- DevTools выключены в prod; `will-navigate`/`setWindowOpenHandler` ограничивают домены.
- Защита исходников web-игр на сервере (nginx, UA `mazalive-desktop`).

## Обратная совместимость

Весь старый путь (`web-game`) не изменён: та же проверка подписки, тот же `createGameWindow`,
те же параметры URL, та же защита. Новый код выполняется только для `gta-koth`.
