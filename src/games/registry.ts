/**
 * Реестр игр Mazlive Desktop 2.0.
 *
 * Каждая игра имеет `type`:
 *  - "web-game"     — обычная HTML5-игра, грузится в BrowserWindow с сервера
 *                     (games.mazlive.com/games/<slug>?room=&token=&lang=)
 *  - "desktop-game" — локальная игра (GTA V Legacy), требующая агента и мода
 *
 * ⚠️ Обратная совместимость: если у игры нет `type`, она считается "web-game".
 * Это гарантирует, что все существующие игры продолжат работать без изменений.
 */

export type GameType = 'web-game' | 'desktop-game'

export interface GameEntry {
  slug: string
  /** По умолчанию (если не указан) — "web-game" для обратной совместимости. */
  type?: GameType
  title: string
  /** Для desktop-game: нужен ли локальный агент (по умолчанию true для desktop-game). */
  requiresDesktopAgent?: boolean
}

/** Реестр desktop-игр (web-игры приходят из дашборда, здесь только то, что нужно лаунчеру). */
export const DESKTOP_GAMES: Record<string, GameEntry> = {
  'gta-koth': {
    slug: 'gta-koth',
    type: 'desktop-game',
    title: 'GTA V — Царь горы',
    requiresDesktopAgent: true,
  },
}

/** Приводит запись к типу с учётом обратной совместимости. */
export function resolveType(entry: Pick<GameEntry, 'type'>): GameType {
  return entry.type === 'desktop-game' ? 'desktop-game' : 'web-game'
}

export function isDesktopGame(slug: string): boolean {
  const e = DESKTOP_GAMES[slug]
  return !!e && resolveType(e) === 'desktop-game'
}

export function isWebGame(slug: string): boolean {
  return !isDesktopGame(slug)
}

/** true, если игре нужен локальный агент. По умолчанию — только для desktop-game. */
export function requiresDesktopAgent(slug: string): boolean {
  const e = DESKTOP_GAMES[slug]
  if (!e) return false
  if (e.requiresDesktopAgent !== undefined) return e.requiresDesktopAgent
  return resolveType(e) === 'desktop-game'
}
