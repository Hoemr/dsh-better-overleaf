<#
.SYNOPSIS
  Re-plug dsh-better-overleaf into the DSH Desktop desktop profile:
  rebuilds the bundle, rewires the junction + manifest, reconciles pnpm,
  and verifies every check the DSH host enforces.

.DESCRIPTION
  The DSH Desktop plugin contract demands ONE name in FOUR places:
    1. package.json `name`
    2. the node_modules junction/directory name (host bundle identity check)
    3. the loader row `name:` in cordis.patch.yml
    4. the client bundle registration `id` (client module system lookups)
  After ANY update (DSH Desktop, dsh-better-sidebar, or a plugin rename),
  run this script once: it rebuilds, re-wires, and tells you exactly which
  of the four checks pass/fail. Idempotent and safe to re-run.

.EXAMPLE
  pwsh scripts/replug.ps1             # build + plug + verify
  pwsh scripts/replug.ps1 -SkipBuild  # only re-wire + verify the existing build
#>
[CmdletBinding()]
param(
  [string]$Repo = '',
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$ProfileDir  = Join-Path $DshHome 'profiles\desktop'
$Nm          = Join-Path $ProfileDir 'node_modules'
$Manifest    = Join-Path $ProfileDir 'package.json'
$AppData     = $env:APPDATA

function Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Ok([string]$Text)   { Write-Host "[OK] $Text"   -ForegroundColor Green }
function Bad([string]$Text)  { Write-Host "[FAIL] $Text" -ForegroundColor Red }

if (-not (Test-Path (Join-Path $Repo 'package.json'))) { throw "package.json not found under $Repo" }
if (-not (Test-Path $Manifest)) { throw "desktop profile manifest not found: $Manifest (wrong DSH home? use -Home)" }

Step '1/6 Read package identity'
$Pkg = Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json
$Name = $Pkg.name
if ([string]::IsNullOrWhiteSpace($Name)) { throw 'package.json name is empty' }
Ok "package name = $Name"
if (-not ($Pkg.dsh.bundle.patch)) { throw 'package.json has no dsh.bundle.patch 鈥?not a DSH bundle' }
Ok "bundle patch = $($Pkg.dsh.bundle.patch)"

Step '2/6 Build (tsc + tsdown)'
if ($SkipBuild) {
  Ok 'skipped (-SkipBuild)'
} else {
  $Shims = Join-Path $Repo 'node_modules\.bin'
  if (-not (Test-Path (Join-Path $Shims 'tsc.cmd')) -or -not (Test-Path (Join-Path $Shims 'tsdown.cmd'))) {
    throw "repo toolchain missing under $Shims 鈥?run `pnpm install` in the repo first"
  }
  Push-Location $Repo
  try {
    cmd /c "node_modules\.bin\tsc.cmd -b --pretty false && node_modules\.bin\tsdown.cmd" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
  Ok 'build complete'
}

Step '3/6 Junction name (host identity)'
$Target = (Resolve-Path $Repo).Path
$Stale  = Get-ChildItem $Nm -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne $Name -and $_.LinkType -eq 'Junction' -and $_.Target -contains $Target }
foreach ($entry in $Stale) {
  Remove-Item $entry.FullName -Force
  Ok "removed stale junction $($entry.Name) -> $Target"
}
$Link = Join-Path $Nm $Name
$LinkItem = Get-Item $Link -Force -ErrorAction SilentlyContinue
if ($null -eq $LinkItem) {
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
  Ok "created junction $Name -> $Target"
} elseif ($LinkItem.LinkType -eq 'Junction') {
  if ($LinkItem.Target -notcontains $Target) {
    Remove-Item $Link -Force
    New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
    Ok "re-pointed junction $Name -> $Target"
  } else {
    Ok "junction already points at $Target"
  }
} else {
  throw "$Link exists and is not a junction; remove it first"
}

Step '4/6 Profile manifest (dependencies + dsh.profile.bundles)'
$ManifestJson = Get-Content $Manifest -Raw | ConvertFrom-Json
$Spec = 'link:' + ($Target -replace '\\', '/')
$Changed = $false
if ($null -eq $ManifestJson.dependencies.$Name) {
  $ManifestJson.dependencies | Add-Member -NotePropertyName $Name -NotePropertyValue $Spec
  $Changed = $true
  Ok "dependencies: added $Name = $Spec"
} else {
  Ok "dependencies: $Name already present"
}
$Bundles = @($ManifestJson.dsh.profile.bundles)
if ($Bundles -notcontains $Name) {
  $MouseIdx = [array]::IndexOf($Bundles, 'dshmarket')
  if ($MouseIdx -ge 0) { $Bundles = $Bundles[0..($MouseIdx-1)] + $Name + $Bundles[$MouseIdx..($Bundles.Length-1)] }
  else { $Bundles += $Name }
  $ManifestJson.dsh.profile.bundles = $Bundles
  $Changed = $true
  Ok 'bundles: added to dsh.profile.bundles'
} else {
  Ok 'bundles: already listed'
}
if ($Changed) {
  $ManifestJson | ConvertTo-Json -Depth 10 | Set-Content $Manifest -Encoding utf8
  Ok 'manifest written'
}

Step '5/6 pnpm reconcile'
$Pnpm = Join-Path $AppData 'DSH Desktop\runtime-commands\bin\pnpm.cmd'
if (-not (Test-Path $Pnpm)) {
  $Cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $Cmd) { throw 'pnpm not found (neither app runtime nor PATH)' }
  $Pnpm = $Cmd.Source
}
Push-Location $ProfileDir
try {
  & $Pnpm install --no-frozen-lockfile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
Ok 'pnpm workspace reconciled'

Step '6/6 Verify (the same checks the DSH host runs)'
$Verify = @'
const { findPackageJSON } = require('node:module');
const { readFileSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const name = process.argv[1];
const profileUrl = 'file:///' + process.argv[2].replace(/\\/g, '/');
const repo = process.argv[3];
const p = findPackageJSON(name, profileUrl);
if (!p) { console.log('IDENTITY:NOT_FOUND'); process.exit(2); }
const m = JSON.parse(readFileSync(p, 'utf8'));
const okName = m.name === name;
const patchFile = join(dirname(p), m.dsh?.bundle?.patch ?? '');
const okPatch = existsSync(patchFile);
const client = readFileSync(join(repo, 'lib/client.js'), 'utf8').slice(0, 200);
const okClient = client.includes(`id: ${JSON.stringify(name)}`);
console.log(`IDENTITY:${okName ? 'OK' : 'MISMATCH'}`);
console.log(`PATCH:${okPatch ? 'OK' : 'MISSING'}`);
console.log(`CLIENT_ID:${okClient ? 'OK' : 'MISMATCH'}`);
'@
$Result = node -e $Verify $Name $Manifest $Target
if ($LASTEXITCODE -ne 0) { throw "verification script failed (exit $LASTEXITCODE)" }
$Check = @{}
$Result | ForEach-Object { if ($_ -match '^([A-Z_]+):(.*)$') { $Check[$matches[1]] = $matches[2] } }
foreach ($key in 'IDENTITY', 'PATCH', 'CLIENT_ID') {
  if ($Check[$key] -eq 'OK') { Ok "$key ok" } else { Bad "$key $($Check[$key])" }
}

# Loader row name in cordis.patch.yml (row `name:` must equal the package name)
$PatchText = Get-Content (Join-Path $Repo $Pkg.dsh.bundle.patch) -Raw
if ($PatchText -notmatch ('name:\s*.?["'']?' + [regex]::Escape($Name))) {
  Write-Host '[WARN] cordis.patch.yml does not contain `name: <package>` - the loader row name will not resolve' -ForegroundColor Yellow
} else {
  Ok 'cordis.patch.yml row name ok'
}

Write-Host ''
if ($Check.Values -contains 'OK' -and $Check.Keys.Count -eq 3) {
  Write-Host 'REPLUG PASS - restart DSH Desktop, the Overleaf tab should appear.' -ForegroundColor Green
} else {
  Write-Host 'REPLUG INCOMPLETE 鈥?see the FAIL lines above; fix the plugin contract, then re-run.' -ForegroundColor Red
}

