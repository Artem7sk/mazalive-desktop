// Тесты ядра агента: конвейер событие→команда, дедуп, лимиты очереди, реконнект-сброс.
// socket.io-client мокаем (deps.loadSocketIo), мост — реальный файловый (временная папка).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {GtaAgent} from '../agent/gta-agent.mjs';

// --- Мок socket.io ---
class FakeSocket extends EventEmitter {
  constructor() { super(); this.emitted = []; this.disconnected = false; }
  emit(evt, ...args) { this.emitted.push([evt, ...args]); return super.emit(evt, ...args); }
  disconnect() { this.disconnected = true; }
}

function makeAgent(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gta-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Готовим status.json мода как running
  const root = path.join(dir, 'scripts', 'MazLiveKOTH');
  fs.mkdirSync(root, { recursive: true });
  const state = { protocol: 2, session: 'b'.repeat(32), updatedAt: Date.now(), phase: 'running', version: '2.0.0-beta.1' };
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(state));

  const sockets = [];
  const agent = new GtaAgent({
    gamePath: dir,
    deps: {
      // loadSocketIo() должен вернуть io-ФАБРИКУ (io(url, opts) → socket)
      loadSocketIo: () => function fakeIo() { const s = new FakeSocket(); sockets.push(s); return s; },
      rulesConfig: opts.rulesConfig,
    },
  });
  return { agent, sockets, dir, root, state };
}

function inboxCount(root) {
  try { return fs.readdirSync(path.join(root, 'inbox')).filter(f => f.endsWith('.cmd')).length; } catch { return 0; }
}

test('connect emits join_room with room/nickname/gameSlug', async t => {
  const { agent, sockets } = makeAgent(t);
  await agent.connect({ room: 'msk001', token: 'JWT', nickname: 'Artem' });
  assert.equal(sockets.length, 1);
  const s = sockets[0];
  s.emit('connect');
  const join = s.emitted.find(e => e[0] === 'join_room');
  assert.ok(join);
  assert.deepEqual(join[1], { roomId: 'msk001', nickname: 'Artem', gameSlug: 'gta-koth' });
  // токен хранится только в памяти
  assert.equal(agent.token, 'JWT');
});

test('tiktok_reaction gift → command written to mod inbox, dedup on repeat', async t => {
  const { agent, sockets, root } = makeAgent(t);
  await agent.connect({ room: 'r', token: 'JWT' });
  sockets[0].emit('connect');
  sockets[0].emit('room_joined', { isStreamerConnected: true });

  const evt = { type: 'gift', giftType: 2, user: 'v1', nickname: 'V1', giftName: 'Rose', giftId: '5655', giftValue: 1, repeatCount: 2, timestamp: 1000 };
  sockets[0].emit('tiktok_reaction', evt);
  assert.equal(inboxCount(root), 1, 'одна команда записана');
  assert.equal(agent.stats.dispatched, 1);
  // повтор того же события — дедуп
  sockets[0].emit('tiktok_reaction', evt);
  assert.equal(inboxCount(root), 1, 'дубль не создаёт новую команду');
  assert.equal(agent.stats.dispatched, 1, 'дубль не отправлен повторно');
  assert.equal(agent.stats.received, 2);
});

test('pending queue never exceeds MAX_PENDING_ACKS (no ACKs)', async t => {
  const { agent, sockets, root } = makeAgent(t);
  await agent.connect({ room: 'r', token: 'JWT' });
  sockets[0].emit('connect');
  sockets[0].emit('room_joined', { isStreamerConnected: true });
  // шлём 150 уникальных событий → мод ставит максимум 100 .cmd (bridge сам режет),
  // агент держит не больше MAX_PENDING_ACKS ожидающих.
  for (let i = 0; i < 150; i++) {
    sockets[0].emit('tiktok_reaction', { type: 'gift', giftType: 2, user: 'u' + i, nickname: 'U', giftName: 'Rose', giftId: '5655', giftValue: 1, repeatCount: 1, timestamp: 2000 + i });
  }
  assert.ok(agent.pending.length <= 100, `pending=${agent.pending.length} <= 100`);
});

test('stream_stopped resets pending queue', async t => {
  const { agent, sockets } = makeAgent(t);
  await agent.connect({ room: 'r', token: 'JWT' });
  sockets[0].emit('connect');
  sockets[0].emit('room_joined', { isStreamerConnected: true });
  sockets[0].emit('tiktok_reaction', { type: 'gift', giftType: 2, user: 'u', nickname: 'U', giftName: 'Rose', giftId: '5655', giftValue: 5, repeatCount: 1, timestamp: 3000 });
  assert.ok(agent.pending.length >= 1);
  sockets[0].emit('stream_stopped', { reason: 'stopped_by_streamer' });
  assert.equal(agent.pending.length, 0);
  assert.equal(agent.streamLive, false);
});

test('disconnect clears token from memory', async t => {
  const { agent } = makeAgent(t);
  await agent.connect({ room: 'r', token: 'SECRET' });
  assert.equal(agent.token, 'SECRET');
  agent.disconnect();
  assert.equal(agent.token, null);
});

test('command not dispatched when mod round is not running', async t => {
  const { agent, sockets, root } = makeAgent(t);
  // меняем phase на idle
  const statusFile = path.join(root, 'status.json');
  fs.writeFileSync(statusFile, JSON.stringify({ protocol: 2, session: 'b'.repeat(32), updatedAt: Date.now(), phase: 'idle', version: 'x' }));
  await agent.connect({ room: 'r', token: 'JWT' });
  sockets[0].emit('connect');
  sockets[0].emit('room_joined', { isStreamerConnected: true });
  sockets[0].emit('tiktok_reaction', { type: 'gift', giftType: 2, user: 'u', nickname: 'U', giftName: 'Rose', giftId: '5655', giftValue: 1, repeatCount: 1, timestamp: 4000 });
  assert.equal(inboxCount(root), 0, 'команда не ушла, т.к. раунд не идёт');
});

test('ACK consumption: queued vs rejected reflected in stats', async t => {
  const { agent, sockets, root } = makeAgent(t);
  await agent.connect({ room: 'r', token: 'JWT' });
  sockets[0].emit('connect');
  sockets[0].emit('room_joined', { isStreamerConnected: true });
  sockets[0].emit('tiktok_reaction', { type: 'gift', giftType: 2, user: 'u', nickname: 'U', giftName: 'Rose', giftId: '5655', giftValue: 1, repeatCount: 1, timestamp: 5000 });
  assert.equal(agent.pending.length, 1);
  const ticket = agent.pending[0].ticket;
  // пишем ACK
  fs.mkdirSync(path.join(root, 'acks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'acks', ticket.id + '.json'), JSON.stringify({ protocol: 2, session: ticket.session, id: ticket.id, outcome: 'queued', detail: '' }));
  agent._pollAcks();
  assert.equal(agent.pending.length, 0);
  assert.equal(agent.stats.acked, 1);
});
