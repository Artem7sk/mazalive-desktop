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
import { execFile, spawn } from 'node:child_process';

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
 */
export function checkDependencies(gamePath: string | null): DepCheck {
  const empty: DepCheck = {
    ok: false,
    missing: ['GAME_PATH'],
    details: { gameExe: false, scriptHookV: false, scriptHookVDotNet: false },
    files: { gameExe: false, shvDll: false, asiLoader: false, shvdnAsi: false, shvdn3Dll: false },
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

  const missing: string[] = [];
  if (!files.gameExe) missing.push('GTA5.exe');
  if (!shvOk) missing.push('ScriptHookV');
  if (!shvdnOk) missing.push('ScriptHookVDotNet');

  const missingComponents: DepCheck['missingComponents'] = [];
  if (!files.gameExe) missingComponents.push({ id: 'GTA', label: 'GTA V Legacy', files: ['GTA5.exe'] });
  if (!shvOk) {
    const lack = [!files.shvDll && 'ScriptHookV.dll', !files.asiLoader && 'dinput8.dll'].filter(Boolean) as string[];
    missingComponents.push({ id: 'ScriptHookV', label: 'ScriptHookV', files: lack });
  }
  if (!shvdnOk) {
    const lack = [!files.shvdnAsi && 'ScriptHookVDotNet.asi', !files.shvdn3Dll && 'ScriptHookVDotNet3.dll'].filter(Boolean) as string[];
    missingComponents.push({ id: 'ScriptHookVDotNet', label: 'ScriptHookVDotNet 3', files: lack });
  }

  return {
    ok: missing.length === 0,
    missing,
    details: { gameExe: files.gameExe, scriptHookV: shvOk, scriptHookVDotNet: shvdnOk },
    files,
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

/** Установка мода. ТРЕБУЕТ готовые зависимости (SHV + SHVDN3). Идемпотентно, с бэкапами. */
export function installMod(gamePath: string, modSourceDir: string) {
  const dep = checkDependencies(gamePath);
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
  const scriptsDir = path.join(gamePath, 'scripts');
  const kothDir = path.join(scriptsDir, 'MazLiveKOTH');
  fs.mkdirSync(kothDir, { recursive: true });
  const bkp = backupDir(gamePath);
  fs.mkdirSync(bkp, { recursive: true });

  const actions: ModAction[] = [];
  const doCopy = (srcName: string, destAbs: string, label: string) => {
    const src = path.join(modSourceDir, srcName);
    if (!fs.existsSync(src)) throw new Error(`Нет файла в пакете: ${srcName}`);
    if (fs.existsSync(destAbs)) {
      const destHash = sha256(destAbs);
      const srcHash = sha256(src);
      if (destHash === srcHash) { actions.push({ file: label, action: 'skip (уже установлен)' }); return; }
      const backup = path.join(bkp, path.basename(destAbs) + '.' + stamp() + '.bak');
      fs.copyFileSync(destAbs, backup);
      actions.push({ file: label, action: 'backup', backup });
    }
    fs.copyFileSync(src, destAbs);
    actions.push({ file: label, action: 'installed' });
  };

  doCopy('MazLiveKOTH.dll', path.join(scriptsDir, 'MazLiveKOTH.dll'), 'scripts/MazLiveKOTH.dll');
  doCopy('settings.ini', path.join(kothDir, 'settings.ini'), 'scripts/MazLiveKOTH/settings.ini');

  const marker = {
    installedBy: 'MAZLIVE',
    version: readModVersion(modSourceDir),
    at: new Date().toISOString(),
    files: ['scripts/MazLiveKOTH.dll', 'scripts/MazLiveKOTH/settings.ini'],
  };
  fs.writeFileSync(path.join(kothDir, '.mazlive-install.json'), JSON.stringify(marker, null, 2));
  return { ok: true, gamePath, actions, marker };
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
}

/**
 * Три состояния мода (для UI):
 *  - `filesInstalled` — только «файлы скопированы»;
 *  - `depsOk` — «зависимости готовы»;
 *  - `ready` — И то, И другое (единственный случай зелёного статуса).
 */
export function getModStatus(gamePath: string | null, modSourceDir: string): ModStatus {
  const deps = checkDependencies(gamePath);
  let filesInstalled = false;
  if (gamePath) {
    const dll = path.join(gamePath, 'scripts', 'MazLiveKOTH.dll');
    const marker = path.join(gamePath, 'scripts', 'MazLiveKOTH', '.mazlive-install.json');
    filesInstalled = fs.existsSync(dll) || fs.existsSync(marker);
  }
  const missingComponents = deps.missingComponents;
  return {
    filesInstalled,
    depsOk: deps.ok,
    ready: filesInstalled && deps.ok,
    deps,
    missingComponents,
  };
}
