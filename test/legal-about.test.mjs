// Тесты правовых документов и локального окна «О программе» (beta.24).
// Проверяют: наличие legal-файлов, их содержимое, локальный словарь about.html,
// отсутствие внешних сетевых запросов/URL в окне About и корректность конфигурации NSIS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(ROOT, '..');
const LEGAL = path.join(REPO, 'legal');
const RENDERER = path.join(REPO, 'renderer');

// Читаем с авто-определением BOM: правовые документы хранятся в UTF-16LE с BOM,
// чтобы NSIS-экран лицензии и «Блокнот» Windows корректно показывали кириллицу
// (иначе UTF-8 без BOM читается как ANSI → кракозябры в установщике).
const read = (p) => {
  const buf = fs.readFileSync(p);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE — вручную переставить байты
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
};

test('legal: все 4 документа присутствуют и непусты (UTF-16LE/BOM или UTF-8)', () => {
  const files = ['LICENSE_RU.txt', 'LICENSE_EN.txt', 'PRIVACY_RU.md', 'PRIVACY_EN.md'];
  for (const f of files) {
    const p = path.join(LEGAL, f);
    assert.ok(fs.existsSync(p), `нет файла ${f}`);
    const txt = read(p);
    assert.ok(txt.length > 500, `${f} слишком короткий`);
    assert.ok(!txt.includes('\uFFFD'), `${f} содержит битые символы`);
  }
});

test('legal: LICENSE_RU.txt кодирован UTF-16LE с BOM (для NSIS-экрана лицензии)', () => {
  // NSIS с unicode=true читает MUI_PAGE_LICENSE как UTF-16; UTF-8 без BOM → кракозябры.
  const buf = fs.readFileSync(path.join(LEGAL, 'LICENSE_RU.txt'));
  assert.ok(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe,
    'LICENSE_RU.txt должен начинаться с BOM UTF-16LE (0xFF 0xFE)');
  const txt = read(path.join(LEGAL, 'LICENSE_RU.txt'));
  assert.ok(txt.includes('ЛИЦЕНЗИОННОЕ СОГЛАШЕНИЕ'),
    'LICENSE_RU.txt: кириллица не декодируется корректно');
  // Проверка, что это НЕ UTF-8-байты (иначе снова будет mojibake в установщике).
  assert.ok(!/Ð›Ð˜Ð¦Ð•Ð/.test(txt), 'LICENSE_RU.txt: обнаружен mojibake UTF-8-как-ANSI');
});

test('EULA RU: ключевые пункты и статус юр. проверки', () => {
  const t = read(path.join(LEGAL, 'LICENSE_RU.txt'));
  for (const kw of ['MAZA PRODUCTION', 'неисключительн', 'стример', 'перепродаж', 'TikTok', 'третьих лиц', 'ОГРАНИЧЕНИЕ ОТВЕТСТВЕННОСТИ']) {
    assert.ok(t.includes(kw), `EULA RU: нет ключевого фрагмента «${kw}»`);
  }
  assert.ok(/юридическ/i.test(t), 'EULA RU: нет пометки о юр. проверке');
});

test('EULA EN: ключевые пункты', () => {
  const t = read(path.join(LEGAL, 'LICENSE_EN.txt'));
  const lower = t.toLowerCase();
  for (const kw of ['MAZA PRODUCTION', 'non-exclusive', 'streamer', 'resale', 'tiktok', 'third-party']) {
    assert.ok(lower.includes(kw.toLowerCase()), `EULA EN: нет ключевого фрагмента «${kw}»`);
  }
  assert.ok(t.includes('LIMITATION OF LIABILITY'), 'EULA EN: нет раздела об ответственности');
});

test('EULA: автор MAZA PRODUCTION, без выдуманных реквизитов', () => {
  const ru = read(path.join(LEGAL, 'LICENSE_RU.txt'));
  const en = read(path.join(LEGAL, 'LICENSE_EN.txt'));
  // Автор проекта заявлен явно, как бренд без юр. реквизитов.
  assert.ok(ru.includes('MAZA PRODUCTION'), 'RU: нет автора MAZA PRODUCTION');
  assert.ok(en.includes('MAZA PRODUCTION'), 'EN: нет автора MAZA PRODUCTION');
  // Не должно быть выдуманных юр. реквизитов (ИНН/адрес/рег. номер).
  assert.ok(!/ИНН|ОГРН|регистрационный номер\s*[:№]/i.test(ru), 'RU: выдуманные юр. реквизиты');
  assert.ok(!/registration number\s*[:#]/i.test(en), 'EN: выдуманные юр. реквизиты');
});

test('Privacy: описывает передачу данных на серверы (не только локально)', () => {
  const ru = read(path.join(LEGAL, 'PRIVACY_RU.md'));
  const en = read(path.join(LEGAL, 'PRIVACY_EN.md'));
  for (const kw of ['mazlive.com', 'games.mazlive.com', 'room token', 'эфира', 'сессия']) {
    assert.ok(ru.toLowerCase().includes(kw.toLowerCase()), `PRIVACY RU: нет «${kw}»`);
  }
  for (const kw of ['mazlive.com', 'games.mazlive.com', 'room token', 'stream', 'session']) {
    assert.ok(en.toLowerCase().includes(kw.toLowerCase()), `PRIVACY EN: нет «${kw}»`);
  }
});

test('about.html: локальный словарь RU/EN и ключевые элементы', () => {
  const html = read(path.join(RENDERER, 'about.html'));
  assert.ok(html.includes('DICT'), 'нет словаря');
  assert.ok(/ru\s*:\s*\{/.test(html) && /en\s*:\s*\{/.test(html), 'нет RU/EN словарей');
  for (const id of ['langRu', 'langEn', 'bCheck', 'bSite', 'vVersion', 'bLicRu', 'bLicEn', 'bPrivRu', 'bPrivEn']) {
    assert.ok(html.includes(`id="${id}"`), `about.html: нет элемента #${id}`);
  }
  assert.ok(html.includes('Third-party') || html.includes('третьих лиц'), 'нет списка компонентов');
});

test('about.html: НЕ делает внешних сетевых запросов при загрузке', () => {
  const html = read(path.join(RENDERER, 'about.html'));
  // CSP запрещает внешние источники; fetch/XHR/WebSocket в загрузке документа быть не должно.
  const script = html.slice(html.indexOf('<script>'));
  assert.ok(!/\bfetch\s*\(/.test(script), 'about.html использует fetch()');
  assert.ok(!/XMLHttpRequest/.test(script), 'about.html использует XMLHttpRequest');
  assert.ok(!/new\s+WebSocket/.test(script), 'about.html использует WebSocket');
  assert.ok(!/io\s*\(/.test(script), 'about.html подключает socket.io');
  // Внешние ссылки — только через мост about.openExternal (shell.openExternal в main).
  assert.ok(html.includes('openExternal'), 'нет безопасного открытия ссылок');
  assert.ok(/default-src 'self'/.test(html), 'нет строгого CSP default-src self');
  assert.ok(!/https?:\/\/[^"'\s]+/.test(script.replace(/https?:\/\/mazlive\.com\//g, '')), 'в скрипте есть внешний URL');
});

test('package.json: NSIS license + legal в files + бета-версия 2.0.0', () => {
  const pkg = JSON.parse(read(path.join(REPO, 'package.json')));
  assert.match(pkg.version, /^2\.0\.0-beta\.\d+$/, 'версия должна быть 2.0.0-beta.N');
  assert.ok(pkg.build.files.includes('legal/**/*'), 'legal/**/* не попадает в сборку');
  assert.ok(pkg.build.nsis, 'нет блока nsis');
  assert.equal(pkg.build.nsis.license, 'legal/LICENSE_RU.txt', 'nsis.license не указывает на EULA');
  assert.equal(pkg.build.nsis.oneClick, false, 'oneClick должен быть false (визард с лицензией)');
  assert.equal(pkg.build.nsis.unicode, true, 'unicode должен быть true');
  assert.ok(Array.isArray(pkg.build.nsis.installerLanguages), 'нет installerLanguages');
  assert.ok(pkg.build.nsis.installerLanguages.includes('ru_RU'), 'нет ru_RU');
  assert.ok(pkg.build.nsis.installerLanguages.includes('en_US'), 'нет en_US');
});

test('updater (generic) не изменён', () => {
  const pkg = JSON.parse(read(path.join(REPO, 'package.json')));
  assert.equal(pkg.build.publish.provider, 'generic', 'провайдер обновлений изменён');
  assert.equal(pkg.build.publish.url, 'https://mazlive.com/api/updates/beta/', 'URL обновлений изменён');
  assert.equal(pkg.build.publish.channel, 'beta', 'канал обновлений изменён');
});

test('main.ts: About-окно изолировано (contextIsolation, без сайта)', () => {
  const src = read(path.join(REPO, 'src', 'main.ts'));
  const about = src.slice(src.indexOf('function createAboutWindow'));
  const body = about.slice(0, about.indexOf('async function openLegalDoc'));
  assert.ok(body.includes('contextIsolation: true'), 'About: нет contextIsolation');
  assert.ok(body.includes("nodeIntegration: false"), 'About: nodeIntegration не false');
  assert.ok(body.includes("loadFile("), 'About: должен грузить локальный файл, не URL');
  assert.ok(!body.includes('loadURL(http'), 'About: не должен грузить сайт');
  assert.ok(body.includes('will-navigate'), 'About: нет защиты will-navigate');
});
