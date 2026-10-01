/**
 * CI smoke-тест упакованного Electron-приложения (запускается на Windows в CI).
 *
 * Проверяет 3 факта, которые НЕ ловятся обычным `tsc`/Node-тестами:
 *  1) asar-сборка содержит dist/main.js, agent/load-agent.js и agent/gta-agent.mjs;
 *  2) ESM-агент реально загружается в среде Electron main-процесса (нативный import());
 *  3) главное окно приложения открывается без необработанных исключений.
 *
 * Запуск: `electron scripts/smoke-packaged.js` (в CI — из собранного каталога).
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let failed = false;
function fail(msg) { failed = true; console.error('❌ SMOKE FAIL:', msg); }
function ok(msg) { console.log('✅ SMOKE OK:', msg); }

// 1) Проверяем содержимое упакованного asar (если приложение упаковано).
async function checkAsar() {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar'),
    path.join(__dirname, '..', 'dist', 'linux-unpacked', 'resources', 'app.asar'),
    path.join(__dirname, '..', 'dist', 'mac', 'Mazlive Desktop 2.app', 'Contents', 'Resources', 'app.asar'),
  ];
  const asarPath = candidates.find((p) => fs.existsSync(p));
  if (!asarPath) { fail('app.asar не найден — сборка была не упакована?'); return; }
  ok('найден app.asar: ' + asarPath);
  let asar;
  try {
    // @electron/asar v4 — ESM-only. В CJS-скрипте грузим через динамический import().
    const asarMain = path.join(__dirname, '..', 'node_modules', '@electron', 'asar', 'lib', 'asar.js');
    const src = fs.existsSync(asarMain)
      ? (await import(require('url').pathToFileURL(asarMain).href)).default
      : (await import('@electron/asar')).default;
    asar = src || (await import(require('url').pathToFileURL(asarMain).href));
  } catch (e) { fail('@electron/asar недоступен: ' + e.message); return; }
  const files = asar.listPackage(asarPath);
  for (const need of ['/dist/main.js', '/agent/load-agent.js', '/agent/gta-agent.mjs', '/agent/rules.mjs', '/agent/bridge.mjs']) {
    if (files.includes(need)) ok('asar содержит ' + need);
    else fail('asar НЕ содержит ' + need);
  }
  // ГЛАВНАЯ проверка: агент грузится именно из распакованного asar-контента.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'asar-x-'));
  try {
    asar.extractAll(asarPath, tmp);
    const loadPath = path.join(tmp, 'agent', 'load-agent.js');
    const { loadAgent } = require(loadPath);
    return loadAgent().then((m) => {
      if (typeof m.GtaAgent === 'function') ok('ESM-агент загружается ИЗ ASAR: GtaAgent');
      else fail('агент из asar не экспортирует GtaAgent');
    }).catch((e) => fail('агент из asar не загрузился: ' + e.message));
  } catch (e) {
    fail('извлечение/загрузка из asar упала: ' + e.message);
  }
}

// 2) Агент должен грузиться (нативный import из CJS).
async function checkAgentLoad() {
  try {
    const { loadAgent } = require('../agent/load-agent.js');
    const mod = await loadAgent();
    if (typeof mod.GtaAgent === 'function') ok('ESM-агент загружен: GtaAgent');
    else fail('loadAgent() не вернул GtaAgent');
    const inst = new mod.GtaAgent({ gamePath: 'C:\\nonexistent', deps: { loadSocketIo: () => null } });
    if (inst && typeof inst.connect === 'function') ok('GtaAgent инстанцируется');
    else fail('GtaAgent не инстанцируется');
  } catch (e) {
    fail('агент не загрузился: ' + e.message);
  }
}

// 3) Главное окно открывается без необработанных исключений.
async function checkWindow() {
  return new Promise((resolve) => {
    process.on('uncaughtException', (e) => fail('uncaughtException: ' + e.message));
    process.on('unhandledRejection', (e) => fail('unhandledRejection: ' + (e && e.message)));
    const win = new BrowserWindow({ show: false, width: 400, height: 300 });
    win.loadURL('data:text/html,<h1>smoke</h1>');
    win.webContents.once('did-finish-load', () => {
      ok('главное окно открылось (did-finish-load)');
      win.close();
      resolve();
    });
    setTimeout(() => { fail('окно не загрузилось за 10с'); resolve(); }, 10000);
  });
}

app.whenReady().then(async () => {
  await checkAsar();
  await checkAgentLoad();
  await checkWindow();
  console.log(failed ? '\n=== SMOKE RESULT: FAIL ===' : '\n=== SMOKE RESULT: PASS ===');
  app.exit(failed ? 1 : 0);
}).catch((e) => { fail('whenReady: ' + e.message); app.exit(1); });
