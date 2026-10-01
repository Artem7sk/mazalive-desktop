/**
 * MAZLIVE GTA Agent — локальное ядро обработки событий эфира.
 *
 * Работает ВНУТРИ Electron main-процесса (в узком preload/IPC-API, без отдельного HTTP-сервера).
 * Задачи:
 *  - подключиться к game-server через Socket.IO: /streamer (open_room + start_tiktok —
 *    поднимает комнату и TikTok-мост, как дашборд у обычных игр) и /viewer (join_room —
 *    подписка на события tiktok_reaction);
 *  - слушать tiktok_reaction;
 *  - через rules.Router превращать события в действия;
 *  - отправлять действия в мод через bridge.ModBridge (файловый протокол v2);
 *  - опрашивать ACK, вести понятный статус, дедуп, ограничение очереди, реконнект;
 *  - НЕ сохранять JWT на диск (только в памяти процесса).
 *
 * Безопасность: JWT держим только в памяти. Никаких process args/логов/файлов с токеном.
 */
import { EventEmitter } from 'node:events';
import { ModBridge } from './bridge.mjs';
import { Router, defaults } from './rules.mjs';

const MAX_PENDING_ACKS = 100;       // максимум одновременно ожидающих ACK (защита от завала)
const ACK_POLL_INTERVAL_MS = 200;   // как часто опрашивать acks/
const ACK_TIMEOUT_MS = 15000;       // сколько ждём ACK на команду

export class GtaAgent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.gamePath  путь к папке GTA (проверенный main-процессом)
   * @param {{loadSocketIo:()=>any, rulesConfig?:object}} opts.deps  инъекция socket.io-client + настройки правил
   */
  constructor({ gamePath, deps }) {
    super();
    if (!gamePath) throw new Error('gamePath обязателен');
    if (!deps || typeof deps.loadSocketIo !== 'function') throw new Error('deps.loadSocketIo обязателен');
    this.gamePath = gamePath;
    this.deps = deps;
    this.bridge = new ModBridge(gamePath);
    this.router = new Router(deps.rulesConfig || defaults);

    // runtime-состояние
    this.socket = null;           // socket.io клиент /viewer (создаётся при connect)
    this.streamerSocket = null;   // socket.io клиент /streamer (поднимает комнату+мост)
    this.token = null;            // JWT — ТОЛЬКО в памяти
    this.room = null;
    this.nickname = null;
    this.gameSlug = 'gta-koth';
    this.connected = false;       // подключены ли к game-server
    this.streamLive = false;      // активен ли эфир в комнате
    this.pending = [];            // очередь ожидающих ACK: {ticket, eventKey, action, count, at}
    this.stats = { received: 0, dispatched: 0, acked: 0, rejected: 0, dedup: 0, dropped: 0 };
    this._poller = null;
    this._lastSession = null;
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  /**
   * Подключиться к game-server.
   * @param {{room:string, token:string, nickname?:string, gameSlug?:string, serverUrl?:string}} p
   */
  async connect({ room, token, nickname, gameSlug, serverUrl }) {
    if (!room || !token) throw new Error('room и token обязательны');
    this.disconnect(); // идемпотентно
    this.room = String(room).toLowerCase();
    this.token = token; // только память
    this.nickname = nickname || this.room;
    if (gameSlug) this.gameSlug = gameSlug;
    // База сервера без namespace (например https://games.mazlive.com)
    const base = (serverUrl || 'https://games.mazlive.com/viewer').replace(/\/(viewer|streamer)\/?$/, '');

    const io = this.deps.loadSocketIo();

    // ─── 1) /streamer: поднимаем комнату и TikTok-мост (как дашборд у обычных игр) ───
    // Именно это делает эфир «живым»; без него /viewer.join_room бесполезен.
    try {
      this.streamerSocket = io(base + '/streamer', {
        path: '/socket.io',
        transports: ['websocket'],
        auth: { token },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 15000,
      });
      this.streamerSocket.on('connect', () => {
        this.streamerSocket.emit('open_room', { roomId: this.room, gameSlug: this.gameSlug });
        this.streamerSocket.emit('start_tiktok', { username: this.room });
        this._emitStatus('stream_connecting', 'Подключаем эфир…');
      });
      this.streamerSocket.on('stream_status', (d) => {
        if (!d) return;
        if (d.status === 'connected') { this.streamLive = true; this._emitStatus('stream_live', d.message || 'Эфир активен'); }
        else if (d.status === 'connecting') { this._emitStatus('stream_connecting', 'Подключение к TikTok…'); }
        else if (d.status === 'ended') { this.streamLive = false; this._emitStatus('waiting', 'Стрим завершён'); }
        else if (d.status === 'stopped') { this.streamLive = false; this._emitStatus('waiting', d.message || 'Эфир остановлен'); }
      });
      this.streamerSocket.on('connect_error', (err) => this._emitStatus('error', 'Ошибка эфира: ' + (err && err.message || 'unknown')));
    } catch (e) {
      this._emitStatus('error', 'Не удалось поднять эфир: ' + (e && e.message));
    }

    // ─── 2) /viewer: подписка на события (tiktok_reaction) ───
    this.socket = io(base + '/viewer', {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token, room: this.room },       // /viewer теперь не требует, но передаём для совместимости
      query: { room: this.room, token },       // как делают игры
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 15000,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this._emitStatus('connected', 'Соединение с MazLive установлено');
      this.socket.emit('join_room', { roomId: this.room, nickname: this.nickname, gameSlug: this.gameSlug });
    });
    this.socket.on('room_joined', (d) => {
      this.streamLive = !!(d && d.isStreamerConnected);
      this._emitStatus(this.streamLive ? 'stream_live' : 'waiting', this.streamLive ? 'Эфир активен' : 'Ожидаем стрим');
    });
    this.socket.on('stream_active', () => { this.streamLive = true; this._emitStatus('stream_live', 'Эфир активен'); });
    this.socket.on('stream_stopped', (d) => { this.streamLive = false; this._resetPending('stream_stopped'); this._emitStatus('waiting', 'Эфир остановлен' + (d && d.reason ? ' (' + d.reason + ')' : '')); });
    this.socket.on('stream_reconnecting', () => this._emitStatus('waiting', 'Связь со стримом потеряна — переподключение…'));
    this.socket.on('room_closed', () => { this.streamLive = false; this._resetPending('room_closed'); this._emitStatus('stopped', 'Комната закрыта'); });
    this.socket.on('disconnect', () => { this.connected = false; this._emitStatus('disconnected', 'Отключено от MazLive — переподключение…'); });
    this.socket.on('connect_error', (err) => this._emitStatus('error', 'Ошибка соединения: ' + (err && err.message || 'unknown')));

    // ГЛАВНОЕ: события эфира
    this.socket.on('tiktok_reaction', (evt) => this._onReaction(evt));

    this._startPoller();
  }

  /** Отключиться от game-server и забыть токен. */
  disconnect() {
    this._stopPoller();
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    if (this.streamerSocket) {
      try { this.streamerSocket.emit('stop_tiktok'); } catch {}
      try { this.streamerSocket.removeAllListeners(); this.streamerSocket.disconnect(); } catch {}
      this.streamerSocket = null;
    }
    if (this.socket) {
      try { this.socket.removeAllListeners(); this.socket.disconnect(); } catch {}
      this.socket = null;
    }
    this.connected = false;
    this.streamLive = false;
    this.token = null;         // стираем из памяти
    this._resetPending('disconnect');
  }

  /**
   * Обновить JWT (живёт 15 мин) и переподключить /streamer-соединение.
   * Вызывается main-процессом по таймеру (~каждые 12 мин), токен держим только в памяти.
   */
  refreshToken(newToken) {
    if (!newToken) return;
    this.token = newToken;
    if (this.streamerSocket) {
      try {
        this.streamerSocket.auth = { token: newToken };
        this.streamerSocket.disconnect().connect();
      } catch {}
    }
  }

  // ─────────────────────── обработка событий ───────────────────────

  _onReaction(evt) {
    this.stats.received++;
    // Не запускаем команды, если раунд не идёт (бридж сам проверит phase, но экономим работу).
    let items;
    try {
      items = this.router.accept(evt);
    } catch (err) {
      this._emitStatus('error', 'Ошибка правил: ' + err.message);
      return;
    }
    if (!items || items.length === 0) {
      // не сработало правило или дедуп
      return;
    }
    for (const item of items) {
      this._dispatch(item);
    }
  }

  _dispatch(item) {
    // Ограничение очереди ожидающих ACK
    if (this.pending.length >= MAX_PENDING_ACKS) {
      this.stats.dropped++;
      this._emitStatus('warn', 'Очередь переполнена — событие пропущено');
      return;
    }
    let ticket;
    try {
      ticket = this.bridge.send(item.action, { count: item.count, name: item.name });
    } catch (err) {
      // Например 'Round not running', 'Mod offline or clock skew', 'Queue full'
      this._emitStatus('warn', 'Команда отклонена: ' + err.message);
      return;
    }
    this.pending.push({ ticket, eventKey: item._eventKey, action: item.action, count: item.count, at: Date.now() });
    this.stats.dispatched++;
    this.emit('command', { action: item.action, count: item.count, name: item.name, ticket });
    this._emitStatus('dispatched', `Отправлено ${item.action} ×${item.count} (в очередь мода)`);
  }

  _startPoller() {
    if (this._poller) return;
    this._poller = setInterval(() => this._pollAcks(), ACK_POLL_INTERVAL_MS);
    if (this._poller.unref) this._poller.unref();
  }

  _stopPoller() {
    if (this._poller) { clearInterval(this._poller); this._poller = null; }
  }

  _pollAcks() {
    if (!this.pending.length) return;
    const now = Date.now();
    const keep = [];
    for (const p of this.pending) {
      // Смена сессии мода → старые команды недействительны
      let ack = null;
      try { ack = this.bridge.ack(p.ticket); } catch { /* ACK mismatch — ждём таймаут */ }
      if (ack) {
        this.stats.acked++;
        if (ack.outcome === 'rejected' || ack.outcome === 'failed') this.stats.rejected++;
        this.emit('ack', { ...p, outcome: ack.outcome, detail: ack.detail });
        this._emitStatus('ack', `Команда ${p.action}: ${this._outcomeRu(ack.outcome)}${ack.detail ? ' — ' + ack.detail : ''}`);
        continue; // consume
      }
      if (now - p.at > ACK_TIMEOUT_MS) {
        // Timeout: результат неизвестен. НЕ повторяем с новым ID автоматически.
        this.emit('ack_timeout', p);
        this._emitStatus('warn', `Нет подтверждения на ${p.action} — результат неизвестен (не повторяем)`);
        continue;
      }
      keep.push(p);
    }
    this.pending = keep;
  }

  _resetPending(_reason) {
    this.pending = [];
  }

  _outcomeRu(o) {
    return ({ queued: 'принято в очередь', applied: 'применено', rejected: 'отклонено модом', failed: 'ошибка мода' })[o] || o;
  }

  _emitStatus(kind, message) {
    this.emit('status', { kind, message, connected: this.connected, streamLive: this.streamLive });
  }

  // ─────────────────────────── состояние ───────────────────────────

  /** Состояние мода (status.json). Может бросить, если мод офлайн. */
  modStatus() {
    return this.bridge.status();
  }

  /** Полная проверка готовности: GTA найдена / мод отвечает / эфир подключён. */
  state() {
    let mod = null, modError = null;
    try { mod = this.bridge.status(); } catch (e) { modError = e.message; }
    return {
      connected: this.connected,
      streamLive: this.streamLive,
      room: this.room,
      modOnline: !!mod,
      modError,
      mod: mod ? { version: mod.version, phase: mod.phase, progress: mod.progress, wins: mod.wins, falls: mod.falls, round: mod.round, seconds: mod.seconds, queue: mod.queue, objects: mod.objects, result: mod.result } : null,
      pending: this.pending.length,
      stats: { ...this.stats },
    };
  }

  /** Управление стримера (start/stop/clear/reset) — не из зрительских правил. */
  control(action, { count = 1, name = 'Streamer' } = {}) {
    if (!['start', 'stop', 'clear', 'reset'].includes(action)) throw new Error('Недопустимое управляющее действие');
    const ticket = this.bridge.send(action, { count, name });
    this.pending.push({ ticket, eventKey: 'control:' + action, action, count, at: Date.now() });
    return ticket;
  }
}
