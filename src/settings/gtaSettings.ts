/**
 * Хранилище настроек GTA «Царь горы» (Mazlive Desktop 2.0 Beta).
 *
 * ПЕРСИСТЕНТ через electron-store (name: 'mazalive-gta'). Настройки беты изолированы
 * (appName 'Mazlive Desktop 2') и НЕ пересекаются со стабильным лаунчером.
 *
 * Структура настроек согласована с agent/rules.mjs:
 *  - reactions: подарки/лайки/follow → действия мода (giftRules, coinsPerAction,
 *    defaultGiftAction, likesPerBoost, followAction, maxPerEvent);
 *  - course: параметры раунда/трассы, которые поддерживает мод (settings.ini:
 *    Angle, Segments, RoundSeconds).
 *
 * Валидация — на стороне main (не доверяем renderer). Значения вне диапазона
 * отбрасываются к дефолту, некорректные правила подарка фильтруются.
 */
import Store from 'electron-store'

// Действия мода (синхронизировано с agent/rules.mjs VIEWER_ACTIONS + управление).
export const MOD_ACTIONS = [
  'car', 'truck', 'tank', 'crate', 'shield', 'boost', 'checkpoint', 'reset', 'start', 'stop', 'clear',
] as const
const VIEWER_ACTIONS = ['car', 'truck', 'tank', 'crate', 'shield', 'boost', 'checkpoint']
type Action = (typeof MOD_ACTIONS)[number]

export interface GiftRule {
  name: string
  id?: string
  action: string
  coinsPerAction: number
}

export interface GtaSettings {
  reactions: {
    likesPerBoost: number
    followAction: string
    giftRules: GiftRule[]
    defaultGiftAction: string
    coinsPerAction: number
    maxPerEvent: number
  }
  course: {
    angle: number      // settings.ini [Course] Angle (8-28°)
    segments: number   // settings.ini [Course] Segments (6-24)
    roundSeconds: number // settings.ini [Course] RoundSeconds
  }
}

export const DEFAULT_SETTINGS: GtaSettings = {
  reactions: {
    likesPerBoost: 100,
    followAction: 'shield',
    giftRules: [
      { name: 'Rose', id: '5655', action: 'car', coinsPerAction: 1 },
      { name: 'Роза', action: 'car', coinsPerAction: 1 },
    ],
    defaultGiftAction: 'truck',
    coinsPerAction: 10,
    maxPerEvent: 12,
  },
  course: {
    angle: 18,
    segments: 14,
    roundSeconds: 300,
  },
}

const store = new Store<{ gta: GtaSettings }>({
  name: 'mazalive-gta',
  defaults: { gta: DEFAULT_SETTINGS },
})

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

function isViewerAction(a: unknown): a is string {
  return typeof a === 'string' && VIEWER_ACTIONS.includes(a)
}

/** Санитайзер: возвращает гарантированно валидные настройки (никогда не бросает). */
export function sanitize(input: Partial<GtaSettings> | undefined): GtaSettings {
  const src = input || {}
  const r = (src.reactions || {}) as Partial<GtaSettings['reactions']>
  const c = (src.course || {}) as Partial<GtaSettings['course']>

  const rawRules = Array.isArray(r.giftRules) ? r.giftRules.slice(0, 100) : DEFAULT_SETTINGS.reactions.giftRules
  const giftRules: GiftRule[] = rawRules
    .filter((g: any) => g && (g.name || g.id) && isViewerAction(g.action))
    .map((g: any) => ({
      name: String(g.name || g.id).slice(0, 40),
      id: g.id ? String(g.id).slice(0, 40) : undefined,
      action: g.action,
      coinsPerAction: clampInt(g.coinsPerAction, 1, 100000, 1),
    }))

  return {
    reactions: {
      likesPerBoost: clampInt(r.likesPerBoost, 1, 100000, DEFAULT_SETTINGS.reactions.likesPerBoost),
      followAction: isViewerAction(r.followAction) ? r.followAction : DEFAULT_SETTINGS.reactions.followAction,
      giftRules: giftRules.length ? giftRules : DEFAULT_SETTINGS.reactions.giftRules,
      defaultGiftAction: isViewerAction(r.defaultGiftAction) ? r.defaultGiftAction : DEFAULT_SETTINGS.reactions.defaultGiftAction,
      coinsPerAction: clampInt(r.coinsPerAction, 1, 100000, DEFAULT_SETTINGS.reactions.coinsPerAction),
      maxPerEvent: clampInt(r.maxPerEvent, 1, 12, DEFAULT_SETTINGS.reactions.maxPerEvent),
    },
    course: {
      angle: clampInt(c.angle, 8, 28, DEFAULT_SETTINGS.course.angle),
      segments: clampInt(c.segments, 6, 24, DEFAULT_SETTINGS.course.segments),
      roundSeconds: clampInt(c.roundSeconds, 30, 3600, DEFAULT_SETTINGS.course.roundSeconds),
    },
  }
}

export const gtaSettings = {
  get(): GtaSettings {
    return sanitize(store.get('gta') as Partial<GtaSettings>)
  },
  set(next: Partial<GtaSettings>): GtaSettings {
    const clean = sanitize(next)
    store.set('gta', clean)
    return clean
  },
  reset(): GtaSettings {
    store.set('gta', DEFAULT_SETTINGS)
    return DEFAULT_SETTINGS
  },
}

export type { Action }
