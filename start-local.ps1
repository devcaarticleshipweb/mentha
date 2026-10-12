param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "Starting MENTHA Paper Trade locally..."
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or not on PATH."
  Write-Host "Install Node.js LTS from https://nodejs.org/ and reopen PowerShell."
  Write-Host ""
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "npm is not installed or not on PATH."
  Write-Host "Install Node.js LTS from https://nodejs.org/ and reopen PowerShell."
  Write-Host ""
  exit 1
}

$envFile = Join-Path $root ".env"
if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $name, $value = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim().Trim('"'), "Process")
  }
} else {
  Write-Host "Missing .env file."
  Write-Host "Create .env from .env.example and add your Supabase and Upstox values."
  Write-Host ""
  exit 1
}

$required = @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET", "MASTER_PIN")
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Process"))) {
    Write-Host "Missing required .env value: $name"
    Write-Host ""
    exit 1
  }
}

$env:PORT = "$Port"

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Write-Host "Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "Open http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

npm start
