# Mazlive Desktop 2.0 Beta

**Streamer Game Launcher с поддержкой обычных HTML5-игр и локальных desktop-игр (GTA V «Царь горы»).**

Версия: `2.0.0-beta.1`

---

## Что нового в 2.0

1. **Типы игр.** Реестр игр получил поле `type`:
   - `web-game` (по умолчанию) — обычные HTML5-игры с сервера;
   - `desktop-game` — локальные игры, требующие агента и мода (GTA V «Царь горы»).
2. **GTA V — Царь горы** (`gta-koth`) — первая desktop-игра.
3. **Локальный агент** — подключается к game-server как зритель, превращает подарки/лайки/подписки в игровые действия GTA.
4. **Менеджер мода** — установка/удаление/проверка мода MazLiveKOTH с бэкапами и защитой от случайного удаления.
5. **Авто-запуск** — проверка GTA, зависимостей, запуск агента и GTA V Legacy (Story Mode), панель управления.

## ⚠️ Обратная совместимость

**Все существующие игры продолжают работать по старой логике:**
`https://games.mazlive.com/games/<slug>?room=<room>&token=<token>&lang=<lang>`

Изменяется **только** маршрутизация: если у игры нет `type`, она считается `web-game` и запускается как раньше.

## Требования (для GTA)

- Windows 10/11 x64
- **GTA V Legacy** (не Enhanced)
- ScriptHookV
- ScriptHookVDotNet 3

## Быстрый старт

```bash
npm ci
npm run build      # tsc
npm start          # запуск Electron
npm test           # unit-тесты агента/правил/моста
```

## Сборка

Только через **GitHub Actions** (`.github/workflows/build.yml`) по тегу `v2.*`.
Локальная сборка EXE на сервере не производится.

## Документация

- [`GTA-KOTH-INSTALL.md`](./GTA-KOTH-INSTALL.md) — установка и сценарий проверки GTA-мода
- [`MAZLIVE-DESKTOP-ARCHITECTURE.md`](./MAZLIVE-DESKTOP-ARCHITECTURE.md) — архитектура
- [`docs/EVENTS.md`](./docs/EVENTS.md) — список поддерживаемых событий
- [`docs/UNINSTALL.md`](./docs/UNINSTALL.md) — удаление
- [`docs/RECOVERY.md`](./docs/RECOVERY.md) — восстановление после ошибки
- [`docs/TESTER-GUIDE.md`](./docs/TESTER-GUIDE.md) — для тестера
- [`docs/STREAMER-GUIDE.md`](./docs/STREAMER-GUIDE.md) — для стримера
- [`docs/TEST-REPORT.md`](./docs/TEST-REPORT.md) — отчёт о тестировании
