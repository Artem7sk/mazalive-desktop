# BUILD-MOD.ps1 — сборка MazLiveKOTH.dll под ФИКСИРОВАННЫЙ ScriptHookVDotNet3 v3.6.0.
# Никаких DLL "из папки GTA": референс берётся ТОЛЬКО из mod\LOCKED_REF (закреплён sha256).
# Падает, если итоговый DLL ссылается на версию API, отличную от 3.6.0.
param(
    [string]$Configuration = 'Release',
    [string]$LockedRef = (Join-Path $PSScriptRoot 'LOCKED_REF\ScriptHookVDotNet3.dll'),
    [string]$LockedRefSha = (Join-Path $PSScriptRoot 'LOCKED_REF\ScriptHookVDotNet3.dll.sha256'),
    [string]$ExpectedApi = '3.6.0.0'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "=== MAZLIVE KOTH build (locked SHVDN $ExpectedApi) ==="

# 1) Проверяем, что LOCKED_REF на месте и совпадает с закреплённым хешем.
if (!(Test-Path -LiteralPath $LockedRef)) { throw "LOCKED_REF missing: $LockedRef" }
$expected = ((Get-Content -LiteralPath $LockedRefSha) -split '\s+')[0].Trim().ToLower()
$actual = (Get-FileHash -LiteralPath $LockedRef -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "LOCKED_REF sha256 mismatch: expected=$expected actual=$actual" }
Write-Host "LOCKED_REF sha256 OK: $actual"

# 2) Убеждаемся, что LOCKED_REF — это ровно версия $ExpectedApi (через AssemblyVersion).
$ver = [System.Reflection.AssemblyName]::GetAssemblyName($LockedRef).Version.ToString()
Write-Host "LOCKED_REF AssemblyVersion: $ver"
if ($ver -ne $ExpectedApi) { throw "LOCKED_REF is not $ExpectedApi (got $ver). Fix LOCKED_REF/ before building." }

# 3) Сборка.
dotnet build (Join-Path $PSScriptRoot 'MazLiveKOTH.csproj') -c $Configuration -v minimal
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

$outDll = Join-Path $PSScriptRoot "bin\$Configuration\MazLiveKOTH.dll"
if (!(Test-Path -LiteralPath $outDll)) { throw "build output not found: $outDll" }

# 4) Критическая проверка: AssemblyRef на ScriptHookVDotNet3 должен быть ИМЕННО $ExpectedApi.
$asm = [System.Reflection.Assembly]::ReflectionOnlyLoadFrom((Resolve-Path $outDll).Path)
$refName = $null
foreach ($r in $asm.GetReferencedAssemblies()) { if ($r.Name -eq 'ScriptHookVDotNet3') { $refName = $r } }
if ($null -eq $refName) { throw "MazLiveKOTH.dll does not reference ScriptHookVDotNet3 at all!" }
$refVer = $refName.Version.ToString()
Write-Host "MazLiveKOTH.dll -> ScriptHookVDotNet3 v$refVer"
if ($refVer -ne $ExpectedApi) {
    throw "API MISMATCH: built DLL requires ScriptHookVDotNet3 v$refVer, expected $ExpectedApi. Build rejected."
}

# 5) Публикуем рядом с mod (в корне mod/), как ждёт INSTALL.ps1.
Copy-Item -LiteralPath $outDll -Destination (Join-Path $PSScriptRoot 'MazLiveKOTH.dll') -Force
$sha = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'MazLiveKOTH.dll') -Algorithm SHA256).Hash.ToLower()
Write-Host "=== BUILD OK ==="
Write-Host "TARGET SHVDN: $ExpectedApi"
Write-Host "DLL API DEP:  ScriptHookVDotNet3 v$refVer"
Write-Host "DLL SHA256:   $sha"
Write-Host "DLL SIZE:     $((Get-Item (Join-Path $PSScriptRoot 'MazLiveKOTH.dll')).Length)"
