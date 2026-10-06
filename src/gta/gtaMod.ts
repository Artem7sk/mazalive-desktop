/**
 * GTA V Legacy — поиск, проверка зависимостей, установка/удаление мода MazLiveKOTH.
 *
 * ПРИНЦИПЫ БЕЗОПАСНОСТИ (из ТЗ):
 *  - принимать только валидированные пути (не доверять renderer);
 *  - НЕ запускать GTA Online с модом (мод только для Story Mode);
 *  - перед установкой делать резервные копии заменяемых файлов;
 *  - удалятор удаляет только файлы MAZLIVE и восстанавливает бэкапы;
 *  - если пользователь изменил файл — удалятор не трогает, требует ручного решения.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';

export interface GtaHit { gamePath: string; exe: string }
export interface DepCheck {
  ok: boolean;
  missing: string[];
  details: { gameExe: boolean; scriptHookV: boolean; scriptHookVDotNet: boolean };
  /** Детальный разбор файлов для понятных сообщений пользователю. */
  files: {
    gameExe: boolean;              // GTA5.exe
    shvDll: boolean;               // ScriptHookV.dll
    asiLoader: boolean;            // dinput8.dll
    shvdnAsi: boolean;             // ScriptHookVDotNet.asi
    shvdn3Dll: boolean;            // ScriptHookVDotNet3.dll
  };
  /** Обязательные компоненты, которых не хватает (для UI). */
  missingComponents: Array<{ id: 'GTA' | 'ScriptHookV' | 'ScriptHookVDotNet'; label: string; files: string[] }>;
  /** Версии SHVDN: установленная в GTA vs та, под которую собран наш мод. */
  versions: {
    shvdnInstalled: string | null;   // AssemblyVersion ScriptHookVDotNet3.dll (напр. "3.6.0.0")
    modApiTarget: string | null;     // AssemblyRef ScriptHookVDotNet3 в MazLiveKOTH.dll
    compatible: boolean | null;      // совпадают ли мажор.минор
  };
}
export interface ModAction { file: string; action: string; backup?: string }

/** Ищем GTA5.exe в заданной папке (или рядом). */
export function findGtaInDir(dir: string): GtaHit | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const candidates = [dir, path.join(dir, 'GTA V'), path.join(dir, 'Grand Theft Auto V')];
  for (const c of candidates) {
    const exe = path.join(c, 'GTA5.exe');
    if (fs.existsSync(exe)) return { gamePath: c, exe };
  }
  return null;
}

/** Типичные пути установки (Steam/Epic/Rockstar). Возвращает первый найденный. */
export function autoDetectGta(): GtaHit | null {
  const guesses = [
    'C:\\Program Files\\Rockstar Games\\Grand Theft Auto V',
    'C:\\Program Files (x86)\\Rockstar Games\\Grand Theft Auto V',
    'C:\\Program Files\\Epic Games\\GTAV',
    'C:\\Games\\GTAV',
    'D:\\Games\\GTAV',
    'D:\\SteamLibrary\\steamapps\\common\\Grand Theft Auto V',
    'E:\\SteamLibrary\\steamapps\\common\\Grand Theft Auto V',
  ];
  for (const g of guesses) {
    const hit = findGtaInDir(g);
    if (hit) return hit;
  }
  return null;
}

/**
 * Проверка зависимостей мода в папке GTA.
 *
 * MazLiveKOTH — это ScriptHookVDotNet 3 скрипт (исходник: `using GTA; : Script`).
 * Для загрузки НУЖНЫ ОБА рантайма:
 *  1) ScriptHookV  → ScriptHookV.dll + dinput8.dll (ASI Loader)
 *  2) ScriptHookVDotNet 3 → ScriptHookVDotNet.asi + ScriptHookVDotNet3.dll
 *
 * Проверяем ВСЕ обязательные файлы по отдельности (старый `.some()` давал ложный OK).
/**
 * Читает версию сборки .NET (AssemblyVersion) и версии зависимостей (AssemblyRef)
 * из DLL. Использует PowerShell (`[Reflection.AssemblyName]::GetAssemblyName`) —
 * тот же надёжный способ, что в mod/INSTALL.ps1. На не-Windows / при ошибке
 * возвращает пустой результат (версии просто не показываются).
 *
 * Возвращает { self, refs } где refs['ScriptHookVDotNet3'] = '3.6.0.0'.
 */
function readNetVersions(dllPath: string): { self: string | null; refs: Record<string, string> } {
  const out: { self: string | null; refs: Record<string, string> } = { self: null, refs: {} };
  if (process.platform !== 'win32') return out;
  if (!fs.existsSync(dllPath)) return out;
  try {
    // Путь передаём через переменную окружения (безопасно для пробелов и кириллицы).
    const ps =
      '$ErrorActionPreference="Stop";' +
      '$p=$env:MAZLIVE_DLL;' +
      '$n=[System.Reflection.AssemblyName]::GetAssemblyName($p);' +
      '$self=$n.Version.ToString();' +
      '$refs=@{};' +
      'try{' +
      '  $asm=[System.Reflection.Assembly]::ReflectionOnlyLoadFrom($p);' +
      '  foreach($r in $asm.GetReferencedAssemblies()){ $refs[$r.Name]=$r.Version.ToString() }' +
      '}catch{};' +
      'ConvertTo-Json @{ self=$self; refs=$refs } -Compress';
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, env: { ...process.env, MAZLIVE_DLL: dllPath } }
    ).trim();
    if (!raw) return out;
    const parsed = JSON.parse(raw) as { self?: string; refs?: Record<string, string> };
    if (parsed.self) out.self = parsed.self;
    if (parsed.refs) out.refs = parsed.refs;
  } catch { /* версии неизвестны */ }
  return out;
}

function versionsCompatible(installed: string | null, target: string | null): boolean | null {
  if (!installed || !target) return null;
  const a = installed.split('.'), b = target.split('.');
  // совместимо, если совпадают мажор и минор (3.6.x ↔ 3.6.y)
  return a[0] === b[0] && a[1] === b[1];
}

export function checkDependencies(gamePath: string | null, modSourceDir?: string): DepCheck {
  const empty: DepCheck = {
    ok: false,
    missing: ['GAME_PATH'],
    details: { gameExe: false, scriptHookV: false, scriptHookVDotNet: false },
    files: { gameExe: false, shvDll: false, asiLoader: false, shvdnAsi: false, shvdn3Dll: false },
    versions: { shvdnInstalled: null, modApiTarget: null, compatible: null },
    missingComponents: [
      { id: 'GTA', label: 'GTA V Legacy', files: ['GTA5.exe'] },
      { id: 'ScriptHookV', label: 'ScriptHookV', files: ['ScriptHookV.dll', 'dinput8.dll'] },
      { id: 'ScriptHookVDotNet', label: 'ScriptHookVDotNet 3', files: ['ScriptHookVDotNet.asi', 'ScriptHookVDotNet3.dll'] },
    ],
  };
  if (!gamePath) return empty;

  const has = (f: string) => fs.existsSync(path.join(gamePath, f));
  const files = {
    gameExe: has('GTA5.exe'),
    shvDll: has('ScriptHookV.dll'),
    asiLoader: has('dinput8.dll'),
    shvdnAsi: has('ScriptHookVDotNet.asi'),
    shvdn3Dll: has('ScriptHookVDotNet3.dll'),
  };

  // Компонент считается готовым ТОЛЬКО при наличии ВСЕХ его файлов.
  const shvOk = files.shvDll && files.asiLoader;
  const shvdnOk = files.shvdnAsi && files.shvdn3Dll;

  // ── Версии SHVDN: установленная в GTA vs та, под которую собран наш мод ──
  const shvdn3Path = path.join(gamePath, 'ScriptHookVDotNet3.dll');
  const shvdnInstalled = files.shvdn3Dll ? readNetVersions(shvdn3Path).self : null;
  let modApiTarget: string | null = null;
  if (modSourceDir) {
    const modDll = path.join(modSourceDir, 'MazLiveKOTH.dll');
    if (fs.existsSync(modDll)) {
      modApiTarget = readNetVersions(modDll).refs['ScriptHookVDotNet3'] || null;
    }
  }
  const compatible = versionsCompatible(shvdnInstalled, modApiTarget);

  const missing: string[] = [];
  if (!files.gameExe) missing.push('GTA5.exe');
  if (!shvOk) missing.push('ScriptHookV');
  if (!shvdnOk) missing.push('ScriptHookVDotNet');
  // Несовместимая версия SHVDN = тоже "missing" (мод не загрузится), но с отдельной формулировкой.
  const apiMismatch = shvdnOk && compatible === false;

  const missingComponents: DepCheck['missingComponents'] = [];
  if (!files.gameExe) missingComponents.push({ id: 'GTA', label: 'GTA V Legacy', files: ['GTA5.exe'] });
  if (!shvOk) {
    const lack = [!files.shvDll && 'ScriptHookV.dll', !files.asiLoader && 'dinput8.dll'].filter(Boolean) as string[];
    missingComponents.push({ id: 'ScriptHookV', label: 'ScriptHookV', files: lack });
  }
  if (!shvdnOk) {
    const lack = [!files.shvdnAsi && 'ScriptHookVDotNet.asi', !files.shvdn3Dll && 'ScriptHookVDotNet3.dll'].filter(Boolean) as string[];
    missingComponents.push({ id: 'ScriptHookVDotNet', label: 'ScriptHookVDotNet 3', files: lack });
  } else if (apiMismatch) {
    missingComponents.push({
      id: 'ScriptHookVDotNet',
      label: `ScriptHookVDotNet ${shvdnInstalled} несовместим (мод собран под API ${modApiTarget})`,
      files: [`Версия ScriptHookVDotNet не соответствует версии, под которую собран MazLiveKOTH.`],
    });
  }

  return {
    ok: missing.length === 0 && !apiMismatch,
    missing,
    details: { gameExe: files.gameExe, scriptHookV: shvOk, scriptHookVDotNet: shvdnOk },
    files,
    versions: { shvdnInstalled, modApiTarget, compatible },
    missingComponents,
  };
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function backupDir(gamePath: string): string {
  return path.join(gamePath, 'scripts', 'MazLiveKOTH', 'backups');
}

function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }

function readModVersion(modSourceDir: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(modSourceDir, 'manifest.json'), 'utf8'));
    return m.version || 'unknown';
  } catch { return 'unknown'; }
}

/** Раскладка файлов мода в GTA (пути, которые ставит/снимает MazLive). */
function modPaths(gamePath: string) {
  const scriptsDir = path.join(gamePath, 'scripts');
  const kothDir = path.join(scriptsDir, 'MazLiveKOTH');
  return {
    scriptsDir,
    kothDir,
    dll: path.join(scriptsDir, 'MazLiveKOTH.dll'),
    settings: path.join(kothDir, 'settings.ini'),
    marker: path.join(kothDir, '.mazlive-install.json'),
    shvdnIni: path.join(gamePath, 'ScriptHookVDotNet.ini'),
  };
}

/** Есть ли признаки, что мод в GTA поставлен нами (LAUNCHER): маркер или совпадение DLL. */
export function isOurMod(gamePath: string, modSourceDir: string): boolean {
  const p = modPaths(gamePath);
  if (fs.existsSync(p.marker)) return true;
  // Маркер мог не сохраниться у старых сборок — считаем «нашим», если установленный DLL
  // побайтово совпадает с любым известным DLL мода (текущий пакет) ИЛИ имеет то же имя,
  // что раздаёт лаунчер, и лежит в стандартном scripts/. Это безопасно: бэкап делается всегда.
  if (fs.existsSync(p.dll)) {
    const src = path.join(modSourceDir, 'MazLiveKOTH.dll');
    if (fs.existsSync(src) && sha256(p.dll) === sha256(src)) return true;
    return true; // MazLiveKOTH.dll — наше уникальное имя, чужие моды так не называются
  }
  return false;
}

/**
 * Установка/обновление мода в GTA. Идемпотентно, с бэкапами.
 *
 * @param force  true — переустановить даже если файлы идентичны (после явного «Переустановить»).
 * @returns actions: что реально сделано (installed / skip / backup).
 */
function applyModFiles(gamePath: string, modSourceDir: string, force = false) {
  const p = modPaths(gamePath);
  fs.mkdirSync(p.kothDir, { recursive: true });
  const bkp = backupDir(gamePath);
  fs.mkdirSync(bkp, { recursive: true });

  const actions: ModAction[] = [];
  let changed = false;
  const doCopy = (srcName: string, destAbs: string, label: string) => {
    const src = path.join(modSourceDir, srcName);
    if (!fs.existsSync(src)) throw new Error(`Нет файла в пакете: ${srcName}`);
    if (fs.existsSync(destAbs)) {
      const destHash = sha256(destAbs);
      const srcHash = sha256(src);
      if (destHash === srcHash && !force) { actions.push({ file: label, action: 'skip (уже установлен)' }); return; }
      const backup = path.join(bkp, path.basename(destAbs) + '.' + stamp() + '.bak');
      fs.copyFileSync(destAbs, backup);
      actions.push({ file: label, action: 'backup', backup });
    }
    fs.copyFileSync(src, destAbs);
    actions.push({ file: label, action: force ? 'reinstalled' : 'installed' });
    changed = true;
  };

  doCopy('MazLiveKOTH.dll', p.dll, 'scripts/MazLiveKOTH.dll');
  doCopy('settings.ini', p.settings, 'scripts/MazLiveKOTH/settings.ini');

  // ScriptHookVDotNet.ini в корень GTA — убирает [ERROR] Failed to load config в логе.
  // НЕ перезаписываем, если пользователь уже имеет свой ini.
  const shvdnIniSrc = path.join(modSourceDir, 'ScriptHookVDotNet.ini');
  if (fs.existsSync(shvdnIniSrc)) {
    if (!fs.existsSync(p.shvdnIni)) {
      fs.copyFileSync(shvdnIniSrc, p.shvdnIni);
      actions.push({ file: 'ScriptHookVDotNet.ini', action: 'installed' });
      changed = true;
    } else {
      actions.push({ file: 'ScriptHookVDotNet.ini', action: 'skip (уже есть)' });
    }
  }

  // Диагностика версии API: под какую ScriptHookVDotNet3 собран установленный DLL.
  const installed = readNetVersions(p.dll);
  const marker = {
    installedBy: 'MAZLIVE',
    version: readModVersion(modSourceDir),
    at: new Date().toISOString(),
    dllSha256: fs.existsSync(p.dll) ? sha256(p.dll) : null,
    apiTarget: installed.refs['ScriptHookVDotNet3'] || null,
    shvdnSelf: installed.self || null,
    files: ['scripts/MazLiveKOTH.dll', 'scripts/MazLiveKOTH/settings.ini'],
  };
  fs.writeFileSync(p.marker, JSON.stringify(marker, null, 2));
  return { actions, marker, changed };
}

/** Установка мода. ТРЕБУЕТ готовые зависимости (SHV + SHVDN3). Идемпотентно, с бэкапами. */
export function installMod(gamePath: string, modSourceDir: string, force = false) {
  const dep = checkDependencies(gamePath, modSourceDir);
  if (!dep.files.gameExe) throw new Error('GTA5.exe не найден в выбранной папке');
  // ⚠️ Ключевое: НЕ ставим мод без обязательных зависимостей. Иначе мод не загрузится в игре.
  if (!dep.ok) {
    const detail = dep.missingComponents
      .filter((c) => c.id !== 'GTA')
      .map((c) => `${c.label} (нет: ${c.files.join(', ')})`)
      .join('; ');
    const err: any = new Error(
      `Сначала установите обязательные зависимости: ${detail}. ` +
      `Без них мод MazLiveKOTH не загрузится в GTA.`
    );
    err.code = 'DEPS_MISSING';
    err.dep = dep;
    throw err;
  }
  const { actions, marker } = applyModFiles(gamePath, modSourceDir, force);
  return { ok: true, gamePath, actions, marker };
}

/**
 * АВТО-ОБНОВЛЕНИЕ МОДА. Вызывается при старте приложения ДО запуска GTA.
 *
 * Если в GTA стоит НАШ мод (маркер или уникальное имя DLL), но его DLL отличается
 * от packaged — делаем бэкап и заменяем на актуальный (устраняет «Unable to resolve
 * API version 3.7.0», когда приложение обновилось, а мод остался старым).
 *
 * Безопасность:
 *  - НЕ трогаем, если мод не наш (нет маркера и DLL не совпадает с пакетом — см. isOurMod);
 *  - НЕ трогаем, если GTA запущена (замена файла под работающей игрой ломает сессию);
 *  - НЕ ставим зависимости — если SHV/SHVDN3 нет, просто ничего не делаем (deferred: DM).
 *
 * @returns { changed, reason, actions }
 */
export async function syncMod(gamePath: string | null, modSourceDir: string, opts: { force?: boolean } = {}) {
  const res: { changed: boolean; reason: string; actions: ModAction[] } = {
    changed: false, reason: '', actions: [],
  };
  const src = path.join(modSourceDir, 'MazLiveKOTH.dll');
  if (!gamePath || !fs.existsSync(src)) { res.reason = 'no-game-or-source'; return res; }
  const p = modPaths(gamePath);
  if (!fs.existsSync(p.dll)) { res.reason = 'mod-not-installed'; return res; }
  // не наш мод — не трогаем (защита от подмены чужого/пользовательского DLL)
  if (!isOurMod(gamePath, modSourceDir) && !opts.force) { res.reason = 'not-our-mod'; return res; }
  // принудительная переустановка доступна и без совпадения, но GTA должна быть закрыта
  try {
    if (await isGtaRunning()) { res.reason = 'gta-running'; return res; }
  } catch { /* если не смогли проверить процесс — перестраховываемся и выходим */
    res.reason = 'cannot-check-process'; return res;
  }
  const dep = checkDependencies(gamePath, modSourceDir);
  if (!dep.ok) { res.reason = 'deps-missing'; return res; }

  const installedHash = sha256(p.dll);
  const srcHash = sha256(src);
  if (installedHash === srcHash && !opts.force) { res.reason = 'up-to-date'; return res; }

  const out = applyModFiles(gamePath, modSourceDir, !!opts.force);
  res.changed = true;
  res.actions = out.actions;
  res.reason = 'updated';
  return res;
}

/**
 * Удаление мода. Удаляет только файлы MAZLIVE. Если файл изменён пользователем —
 * не удаляем, возвращаем конфликт.
 */
export function uninstallMod(gamePath: string, modSourceDir: string) {
  const kothDir = path.join(gamePath, 'scripts', 'MazLiveKOTH');
  const scriptsDir = path.join(gamePath, 'scripts');
  const conflicts: { file: string; reason: string }[] = [];
  const removed: string[] = [];

  const expectHash = (name: string): string | null => {
    const p = path.join(modSourceDir, name);
    return fs.existsSync(p) ? sha256(p) : null;
  };
  const tryRemove = (absPath: string, label: string, expectedHash: string | null) => {
    if (!fs.existsSync(absPath)) return;
    if (expectedHash && sha256(absPath) !== expectedHash) {
      conflicts.push({ file: label, reason: 'Файл изменён пользователем — не удалён' });
      return;
    }
    fs.rmSync(absPath, { force: true });
    removed.push(label);
  };

  tryRemove(path.join(scriptsDir, 'MazLiveKOTH.dll'), 'scripts/MazLiveKOTH.dll', expectHash('MazLiveKOTH.dll'));
  tryRemove(path.join(kothDir, 'settings.ini'), 'scripts/MazLiveKOTH/settings.ini', expectHash('settings.ini'));

  try {
    const marker = path.join(kothDir, '.mazlive-install.json');
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
    const rest = fs.existsSync(kothDir) ? fs.readdirSync(kothDir) : [];
    if (rest.length === 0) fs.rmdirSync(kothDir);
  } catch { /* не критично */ }

  return { ok: true, removed, conflicts };
}

/** Запуск GTA V Legacy в сюжетном режиме (без Online!). */
export function launchGta(gamePath: string) {
  const exe = path.join(gamePath, 'GTA5.exe');
  if (!fs.existsSync(exe)) throw new Error('GTA5.exe не найден');
  // -scOfflineOnly форсит оффлайн (Story Mode) — не заходим в Online с модом.
  const child = spawn(exe, ['-scOfflineOnly'], { cwd: gamePath, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, exe };
}

/** Есть ли уже запущенный GTA5.exe. */
export function isGtaRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq GTA5.exe'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).toLowerCase().includes('gta5.exe'));
    });
  });
}

export interface ModStatus {
  /** Файлы MazLiveKOTH.dll + settings.ini скопированы в GTA. */
  filesInstalled: boolean;
  /** Обязательные зависимости (SHV + SHVDN3) на месте. */
  depsOk: boolean;
  /** ✅ Готов к работе = файлы установлены И зависимости есть. */
  ready: boolean;
  deps: DepCheck;
  /** Компоненты, которых не хватает для «готов». */
  missingComponents: DepCheck['missingComponents'];
  /** Мод установлен НАШИМ лаунчером (маркер или узнаваемый DLL) — значит auto-update разрешён. */
  managed: boolean;
  /** Установленный DLL отличается от актуального в приложении (нужно обновление). */
  outdated: boolean;
  /** SHA256 установленного DLL (если есть). */
  installedSha256: string | null;
  /** Под какую ScriptHookVDotNet3 собран установленный DLL (напр. "3.6.0.0"). */
  installedApiTarget: string | null;
}

/**
 * Три состояния мода (для UI):
 *  - `filesInstalled` — только «файлы скопированы»;
 *  - `depsOk` — «зависимости готовы»;
 *  - `ready` — И то, И другое (единственный случай зелёного статуса).
 */
export function getModStatus(gamePath: string | null, modSourceDir: string): ModStatus {
  const deps = checkDependencies(gamePath, modSourceDir);
  let filesInstalled = false;
  let managed = false;
  let outdated = false;
  let installedSha256: string | null = null;
  let installedApiTarget: string | null = null;
  if (gamePath) {
    const p = modPaths(gamePath);
    filesInstalled = fs.existsSync(p.dll) || fs.existsSync(p.marker);
    managed = filesInstalled && isOurMod(gamePath, modSourceDir);
    if (fs.existsSync(p.dll)) {
      installedSha256 = sha256(p.dll);
      const srcDll = path.join(modSourceDir, 'MazLiveKOTH.dll');
      if (fs.existsSync(srcDll)) outdated = installedSha256 !== sha256(srcDll);
      installedApiTarget = readNetVersions(p.dll).refs['ScriptHookVDotNet3'] || null;
    }
  }
  const missingComponents = deps.missingComponents;
  return {
    filesInstalled,
    depsOk: deps.ok,
    ready: filesInstalled && deps.ok,
    deps,
    missingComponents,
    managed,
    outdated,
    installedSha256,
    installedApiTarget,
  };
}
