param(
  [int]$Port = 3005
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "Starting PowerShell-only local demo..."
Write-Host "Open: http://127.0.0.1:$Port/?local=1"
Write-Host "Master login: MASTER / 1234"
Write-Host "Demo trader: TRADER1 / 1111"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

& powershell -NoProfile -ExecutionPolicy Bypass -File "$root\server.ps1" -Port $Port
