// prepare-mod-dist.mjs — собирает чистую папку mod-dist/ только с файлами,
// которые нужны пользователю (без исходников, LOCKED_REF, bin/obj).
// Используется electron-builder (extraResources from=mod-dist) и dev-запуском.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(root, 'mod')
const dst = path.join(root, 'mod-dist')

// Что реально нужно в рантайме:
//  - MazLiveKOTH.dll       — сам мод, ставится в scripts/
//  - settings.ini          — настройки, ставится в scripts/MazLiveKOTH/
//  - ScriptHookVDotNet.ini — кладётся в корень GTA (убирает ошибку конфига)
//  - manifest.json         — версия мода (readModVersion)
const wanted = ['MazLiveKOTH.dll', 'settings.ini', 'ScriptHookVDotNet.ini', 'manifest.json']

fs.rmSync(dst, { recursive: true, force: true })
fs.mkdirSync(dst, { recursive: true })

const copied = []
for (const f of wanted) {
  const s = path.join(src, f)
  if (!fs.existsSync(s)) { console.error('MISSING:', f); process.exitCode = 1; continue }
  fs.copyFileSync(s, path.join(dst, f))
  copied.push(f)
}
console.log('mod-dist prepared:', copied.join(', '))
if (!copied.includes('MazLiveKOTH.dll')) {
  console.error('FATAL: MazLiveKOTH.dll отсутствует — билд мода не выполнен?')
  process.exit(1)
}
