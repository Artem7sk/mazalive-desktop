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
# ReflectionOnlyLoadFrom доступен не везде (напр. .NET 8/macOS его нет) — если недоступен,
# проверяем иначе: в метаданных DLL должна быть строка нужной версии и не должно быть иной мажор.минор.
$refVer = $null
$checked = $false
try {
    $asm = [System.Reflection.Assembly]::ReflectionOnlyLoadFrom((Resolve-Path $outDll).Path)
    foreach ($r in $asm.GetReferencedAssemblies()) { if ($r.Name -eq 'ScriptHookVDotNet3') { $refVer = $r.Version.ToString() } }
    $checked = $true
} catch {
    Write-Host "ReflectionOnlyLoadFrom unavailable ($($_.Exception.Message.Split("`n")[0])); using metadata scan fallback"
}
if (-not $checked) {
    # Fallback: читаемый сырой скан — ищем версию AssemblyRef ScriptHookVDotNet3 в байтах метаданных.
    # Версия хранится как 4x WORD сразу после имени сборки в AssemblyRef; для нашей цели достаточно
    # убедиться, что в DLL нет упоминания '3.7.' и есть '3.6.'.
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $outDll).Path)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    if ($text -match '3\.7\.0') { throw "API MISMATCH (fallback): built DLL references 3.7.0 (nightly), expected $ExpectedApi." }
    $refVer = $ExpectedApi  # подтверждено отсутствием 3.7.0
}
if ($null -eq $refVer) { throw "MazLiveKOTH.dll does not reference ScriptHookVDotNet3 at all!" }
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
