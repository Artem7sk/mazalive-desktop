param([string]$GamePath)
$ErrorActionPreference='Stop'
if(!$GamePath){$GamePath=(Read-Host 'GTA V Legacy folder (contains GTA5.exe)').Trim().Trim('"')}
$GamePath=(Resolve-Path -LiteralPath $GamePath).Path
if(Get-Process GTA5,GTA5_Enhanced -ErrorAction SilentlyContinue){throw 'Close GTA before installing'}
foreach($f in @('GTA5.exe','ScriptHookV.dll','dinput8.dll','ScriptHookVDotNet.asi','ScriptHookVDotNet3.dll')){if(!(Test-Path -LiteralPath (Join-Path $GamePath $f))){throw "Missing $f. Install compatible official dependencies first; see README.md"}}
# Проверяем, что установленный SHVDN той версии, под которую собран мод (API 3.6.0).
$apiDll=Join-Path $GamePath 'ScriptHookVDotNet3.dll'
$installedApi=([System.Reflection.AssemblyName]::GetAssemblyName($apiDll)).Version.ToString()
if($installedApi -notlike '3.6.*'){throw "ScriptHookVDotNet version mismatch: installed $installedApi, MazLiveKOTH built for 3.6.0. Install official ScriptHookVDotNet v3.6.0."}
$root=Join-Path $GamePath 'scripts\MazLiveKOTH'
$manifest=Join-Path $root 'beta-install.json'
if(Test-Path -LiteralPath $manifest){throw 'Beta already installed. Uninstall beta first to restore previous files.'}
$source=Join-Path $PSScriptRoot 'mod\MazLiveKOTH.dll'
if(!(Test-Path -LiteralPath $source)){throw "MazLiveKOTH.dll not found at $source. Build it with mod\BUILD-MOD.ps1 (locked SHVDN 3.6.0)."}
$backupRoot=Join-Path $root ('backups\'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$entries=New-Object 'System.Collections.Generic.List[object]'
function Change-File([string]$relative,[string]$sourceFile){
 $dest=Join-Path $GamePath $relative
 $backup=$null
 if(Test-Path -LiteralPath $dest){$backup=Join-Path $backupRoot ([Guid]::NewGuid().ToString('N'));Copy-Item -LiteralPath $dest -Destination $backup}
 $entry=[pscustomobject]@{relative=$relative;backup=$backup;hash=$null;removed=(!$sourceFile)}
 $entries.Add($entry)
 if($sourceFile){New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null;Copy-Item -LiteralPath $sourceFile -Destination $dest -Force;$entry.hash=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash}
 elseif(Test-Path -LiteralPath $dest){Remove-Item -LiteralPath $dest}
}
try{
 # Disable duplicate source copies of THIS mod, preserving backups.
 foreach($f in @('scripts\MazLiveKOTH.cs','scripts\MazLiveKOTH.3.cs')){if(Test-Path -LiteralPath (Join-Path $GamePath $f)){Change-File $f $null}}
 Change-File 'scripts\MazLiveKOTH.dll' $source
 if(!(Test-Path -LiteralPath (Join-Path $root 'settings.ini'))){Change-File 'scripts\MazLiveKOTH\settings.ini' (Join-Path $PSScriptRoot 'mod\settings.ini')}
 foreach($d in @('inbox','acks')){New-Item -ItemType Directory -Path (Join-Path $root $d) -Force | Out-Null}
 [pscustomobject]@{version='2.0.0-beta.1';gamePath=$GamePath;files=@($entries.ToArray())} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
 Write-Host 'Installed beta. Start Story Mode, press F7. F10 stops and returns you.'
}catch{
 for($i=$entries.Count-1;$i -ge 0;$i--){$e=$entries[$i];$dest=Join-Path $GamePath $e.relative;if($e.backup){Copy-Item -LiteralPath $e.backup -Destination $dest -Force}elseif(Test-Path -LiteralPath $dest){Remove-Item -LiteralPath $dest}}
 throw
}
