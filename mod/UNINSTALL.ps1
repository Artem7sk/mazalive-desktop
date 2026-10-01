param([string]$GamePath)
$ErrorActionPreference='Stop'
if(!$GamePath){$GamePath=(Read-Host 'GTA V Legacy folder').Trim().Trim('"')}
$GamePath=(Resolve-Path -LiteralPath $GamePath).Path
if(Get-Process GTA5,GTA5_Enhanced -ErrorAction SilentlyContinue){throw 'Close GTA first'}
$root=Join-Path $GamePath 'scripts\MazLiveKOTH'
$manifest=Join-Path $root 'beta-install.json'
$m=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if($m.gamePath -ne $GamePath -or $m.version -ne '2.0.0-beta.1'){throw 'Unexpected install manifest'}
$allowed=@('scripts\MazLiveKOTH.dll','scripts\MazLiveKOTH.cs','scripts\MazLiveKOTH.3.cs','scripts\MazLiveKOTH\settings.ini')
foreach($e in $m.files){
 if($e.relative -notin $allowed){throw 'Unexpected path in manifest'}
 $dest=Join-Path $GamePath $e.relative
 if($e.backup){$b=[IO.Path]::GetFullPath($e.backup);$prefix=[IO.Path]::GetFullPath((Join-Path $root 'backups'))+[IO.Path]::DirectorySeparatorChar;if(!$b.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $b)){throw 'Invalid or missing backup'}}
 if(Test-Path -LiteralPath $dest){if($e.removed -or (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -ne $e.hash){throw "File changed after installation: $dest. Resolve manually; no files removed."}}
}
foreach($e in $m.files){$dest=Join-Path $GamePath $e.relative;if($e.backup){Copy-Item -LiteralPath $e.backup -Destination $dest -Force}elseif(Test-Path -LiteralPath $dest){Remove-Item -LiteralPath $dest}}
Remove-Item -LiteralPath $manifest
Write-Host 'Beta removed. Previous files restored. Stats, logs, and backups retained.'
