/**
 * CJS-обёртка для динамической загрузки ESM-агента (agent/gta-agent.mjs).
 *
 * ПОЧЕМУ ТАК: main-процесс Electron собирается в CommonJS (module: commonjs),
 * и обычный import/require ESM-файла падает с ERR_REQUIRE_ESM в упакованном asar.
 * Здесь нативный `import()` — Node/Electron его поддерживают из CJS-контекста,
 * и он НЕ переписывается компилятором TypeScript (этот файл — чистый .js).
 *
 * Файл НЕ компилируется tsc (лежит вне src/) и попадает в asar через поле files ("agent/").
 */
'use strict';

let cached = null;

/** Ленивая загрузка модуля агента. Бросает понятную ошибку при несовместимости. */
async function loadAgent() {
  if (cached) return cached;
  try {
    const mod = await import('./gta-agent.mjs');
    if (!mod || typeof mod.GtaAgent !== 'function') {
      throw new Error('Модуль агента загружен, но не экспортирует GtaAgent');
    }
    cached = mod;
    return mod;
  } catch (err) {
    const e = new Error(
      'Не удалось загрузить GTA-агент (agent/gta-agent.mjs): ' + (err && err.message ? err.message : String(err))
    );
    e.cause = err;
    throw e;
  }
}

module.exports = { loadAgent };
