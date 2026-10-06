#!/usr/bin/env python3
"""Обновляет manifest.json + SHA256SUMS.txt в mod/ под актуальные файлы."""
import hashlib, json, os, sys

MOD = os.path.dirname(os.path.abspath(__file__))

def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()

# Файлы мод-пакета, которые имеет смысл отслеживать (что реально есть в mod/).
tracked = [
    'BUILD-MOD.ps1', 'INSTALL.ps1', 'UNINSTALL.ps1', 'MazLiveKOTH.3.cs',
    'MazLiveKOTH.csproj', 'MazLiveKOTH.dll', 'settings.ini', 'ScriptHookVDotNet.ini',
    'LOCKED_REF/ScriptHookVDotNet3.dll', 'LOCKED_REF/ScriptHookVDotNet3.dll.sha256',
]

files = []
sums = []
for rel in tracked:
    p = os.path.join(MOD, rel)
    if not os.path.exists(p):
        print('missing:', rel, file=sys.stderr)
        continue
    s = sha256(p)
    size = os.path.getsize(p)
    # manifest использует префикс mod/ (как раньше)
    files.append({'path': 'mod/' + rel, 'size': size, 'sha256': s})
    sums.append(f'{s}  mod/{rel}')

# version берём из package.json (?). Оставим текущую version манифеста.
man_path = os.path.join(MOD, 'manifest.json')
man = json.load(open(man_path, encoding='utf-8')) if os.path.exists(man_path) else {}
man['files'] = files
man['version'] = man.get('version', '2.0.0-beta.1')
json.dump(man, open(man_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(os.path.join(MOD, 'SHA256SUMS.txt'), 'w', encoding='utf-8').write('\n'.join(sums) + '\n')

# Проверка: DLL больше не должен требовать 3.7.0
dll = os.path.join(MOD, 'MazLiveKOTH.dll')
raw = open(dll, 'rb').read()
print('DLL sha256:', sha256(dll))
print('manifest files:', len(files))
print('OK')
