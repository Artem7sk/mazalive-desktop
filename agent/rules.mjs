/**
 * Правила преобразования событий TikTok → действия мода GTA «Царь горы».
 *
 * ИСТОЧНИК: доработано из пакета mazlive-koth-beta (agent/rules.mjs).
 * ИЗМЕНЕНИЯ ПРОТИВ ОРИГИНАЛА (проверено по коду game-server/src/index.ts, 2026-10-01):
 *  1. ДЕДУП: реальный payload tiktok_reaction НЕ содержит groupId/eventId/msgId.
 *     Поэтому дедуп строится по составному ключу из стабильных полей события
 *     (тип + uid + giftId + timestamp + repeatCount ...), а если у события есть
 *     свой id (groupId/eventId) — он имеет приоритет. Иначе два разных подарка
 *     от одного зрителя за одну миллисекунду могли бы схлопнуться.
 *  2. Тип 'follow': сервер уже фильтрует повторные follow (firstTime). Дополнительно
 *     уважаем e.firstTime === false → не действие (защита от повторной подписки).
 *  3. likeCount: используем точное поле likeCount/count.
 *  4. count ограничивается maxPerEvent (<=12) ПОСЛЕ пересчёта (как в ТЗ).
 */

export const actions = ['car', 'truck', 'tank', 'crate', 'shield', 'boost', 'checkpoint', 'reset', 'start', 'stop', 'clear'];

// Действия, доступные зрительским правилам (управление стримера — отдельно).
const VIEWER_ACTIONS = ['car', 'truck', 'tank', 'crate', 'shield', 'boost', 'checkpoint'];

export const defaults = {
  likesPerBoost: 100,
  followAction: 'shield',
  giftRules: [
    { name: 'Rose', id: '5655', action: 'car', coinsPerAction: 1 },
    { name: 'Роза', action: 'car', coinsPerAction: 1 },
  ],
  defaultGiftAction: 'truck',
  coinsPerAction: 10,
  maxPerEvent: 12,
};

export function validate(c) {
  if (!c || !Array.isArray(c.giftRules) || c.giftRules.length > 100) throw Error('Неверный список подарков');
  for (const k of ['likesPerBoost', 'coinsPerAction', 'maxPerEvent']) {
    if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > (k === 'maxPerEvent' ? 12 : 100000)) throw Error('Неверное значение ' + k);
  }
  if (!VIEWER_ACTIONS.includes(c.followAction) || !VIEWER_ACTIONS.includes(c.defaultGiftAction)) throw Error('Неизвестное действие');
  for (const r of c.giftRules) {
    if (!VIEWER_ACTIONS.includes(r.action) || !Number.isInteger(r.coinsPerAction) || r.coinsPerAction < 1 || r.coinsPerAction > 100000 || !(r.name || r.id)) throw Error('Неверное правило подарка');
  }
  return structuredClone(c);
}

export class Router {
  constructor(config = defaults) {
    this.config = validate(config);
    this.seen = new Set();        // ключи событий (дедуп по eventId/groupId ИЛИ составному ключу)
    this.likes = new Map();       // uid → накопленные лайки (остаток)
    this.followers = new Set();   // uid → уже был follow в этой сессии агента
  }

  /** Стабильный ключ события для дедупликации. */
  _eventKey(e, uid) {
    const explicit = e.groupId || e.eventId || e.msgId || e.id;
    if (explicit !== undefined && explicit !== null && String(explicit) !== '') {
      return `${e.type}:${uid}:${explicit}`;
    }
    // Реальный payload game-server НЕ даёт id → строим составной ключ из стабильных полей.
    // timestamp в payload есть (Date.now() на сервере) — идеально для этого.
    const ts = e.timestamp ?? 0;
    if (e.type === 'gift') return `gift:${uid}:${e.giftId ?? ''}:${ts}:${e.repeatCount ?? 1}`;
    if (e.type === 'like') return `like:${uid}:${ts}:${e.likeCount ?? e.count ?? 0}`;
    if (e.type === 'follow') return `follow:${uid}:${ts}`;
    return `${e.type}:${uid}:${ts}`;
  }

  /**
   * Принимает событие tiktok_reaction, возвращает массив действий для мода.
   * @returns {Array<{action:string,count:number,name:string}>}
   */
  accept(e) {
    if (!e || !['gift', 'like', 'follow'].includes(e.type)) return [];

    // giftType=1 (streak) — учитываем ТОЛЬКО repeatEnd=true. Сервер обычно уже фильтрует,
    // но защищаемся и здесь (на случай прямых событий/изменений сервера).
    if (e.type === 'gift' && (e.repeatEnd === false || (Number(e.giftType) === 1 && e.repeatEnd !== true))) return [];

    // Повторная подписка (сервер уже помечает firstTime=false) — игнор ДО дедупа,
    // чтобы не «съесть» ключ и обработать первое настоящее follow.
    if (e.type === 'follow' && e.firstTime === false) return [];

    const u = typeof e.user === 'object' && e.user ? e.user : {};
    const uid = String(u.uniqueId || u.userId || e.uniqueId || e.userId || (typeof e.user === 'string' ? e.user : 'anonymous')).slice(0, 100);
    const name = String(u.nickname || e.nickname || u.uniqueId || uid).replace(/[\r\n\t~]/g, ' ').slice(0, 40);

    // Дедупликация
    const key = this._eventKey(e, uid);
    if (this.seen.has(key)) return [];
    this.seen.add(key);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);

    let action, count = 1;
    const c = this.config;

    if (e.type === 'like') {
      const n = Number(e.likeCount ?? e.count ?? 1);
      if (!Number.isFinite(n) || n <= 0) return [];
      const sum = (this.likes.get(uid) || 0) + Math.min(n, 100000);
      count = Math.floor(sum / c.likesPerBoost);
      this.likes.set(uid, sum % c.likesPerBoost);
      if (this.likes.size > 10000) this.likes.delete(this.likes.keys().next().value);
      if (count < 1) return [];
      action = 'boost';
    } else if (e.type === 'follow') {
      if (this.followers.has(uid)) return [];
      this.followers.add(uid);
      if (this.followers.size > 10000) this.followers.delete(this.followers.values().next().value);
      action = c.followAction;
    } else {
      const value = Number(e.giftValue ?? e.diamondCount ?? 1);
      const repeat = Number(e.repeatCount ?? 1);
      if (!Number.isFinite(value) || !Number.isFinite(repeat) || value <= 0 || repeat <= 0) return [];
      const r = c.giftRules.find(r => r.id && String(r.id) === String(e.giftId))
        || c.giftRules.find(r => r.name && r.name.toLowerCase() === String(e.giftName || '').toLowerCase());
      action = r?.action || c.defaultGiftAction;
      count = Math.max(1, Math.floor((value * repeat) / (r?.coinsPerAction || c.coinsPerAction)));
    }

    count = Math.min(c.maxPerEvent, count);
    return count > 0 ? [{
      action,
      count,
      name,
      // метаданные для связи event→command в памяти агента (не уходят в мод)
      _eventKey: key,
    }] : [];
  }
}
