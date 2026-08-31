# Post-restart smoke test for the dsh-better-overleaf host routes.
# Usage: powershell -File scripts\smoke-routes.ps1 [-Port 59527]
param(
  [int]$Port = 59527
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"

function Invoke-OverleafRoute([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 4 -Compress
  try {
    $response = Invoke-WebRequest -Uri "$base$Path" -Method Post -ContentType 'application/json' `
      -Body $json -TimeoutSec 15 -UseBasicParsing
    return [pscustomobject]@{ Status = $response.StatusCode; Ok = $true; Payload = ($response.Content | ConvertFrom-Json) }
  } catch {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    return [pscustomobject]@{ Status = [int]$_.Exception.Response.StatusCode; Ok = $false; Payload = ($reader.ReadToEnd() | ConvertFrom-Json) }
  }
}

Write-Host "== dsh-better-overleaf smoke against $base =="

$status = Invoke-OverleafRoute '/overleaf/status' @{}
Write-Host ("status   -> {0} ok={1} loggedIn={2} gitConfigured={3}" -f `
  $status.Status, $status.Ok, $status.Payload.value.loggedIn, $status.Payload.value.gitConfigured)

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-better-overleaf-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $bindings = Invoke-OverleafRoute '/overleaf/bindings' @{ workspacePath = $temp }
  Write-Host ("bindings -> {0} ok={1} count={2}" -f $bindings.Status, $bindings.Ok, $bindings.Payload.value.bindings.Count)

  $projects = Invoke-OverleafRoute '/overleaf/projects' @{}
  if ($projects.Ok) {
    Write-Host ("projects -> {0} count={1}" -f $projects.Status, $projects.Payload.value.Count)
  } else {
    Write-Host ("projects -> {0} (expected before login: {1})" -f $projects.Status, $projects.Payload.error.message)
  }

  $badSync = Invoke-OverleafRoute '/overleaf/sync' @{ mirrorPath = "$temp\none"; direction = 'pull' }
  Write-Host ("sync-miss-> {0} error={1}" -f $badSync.Status, $badSync.Payload.error.message)
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host '== done =='
