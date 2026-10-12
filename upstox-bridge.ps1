param(
  [string]$ConfigPath = "$PSScriptRoot\upstox-config.ps1"
)

. $ConfigPath

if ([string]::IsNullOrWhiteSpace($AccessToken)) {
  Write-Host ""
  Write-Host "Add your Upstox access token in upstox-config.ps1 first."
  Write-Host "Do not paste the token in chat."
  Write-Host ""
  exit 1
}

$script:lastQuote = $null
$script:lastError = $null
$encodedKey = [System.Uri]::EscapeDataString($InstrumentKey)
$quoteUrl = "https://api.upstox.com/v2/market-quote/quotes?instrument_key=$encodedKey"

function Convert-UpstoxQuote($raw) {
  $first = $raw.data.PSObject.Properties | Select-Object -First 1
  if (-not $first) { throw "No quote returned for $InstrumentKey" }

  $q = $first.Value
  $buy = @()
  $sell = @()

  if ($q.depth.buy) {
    foreach ($level in $q.depth.buy) {
      if ([double]$level.price -gt 0) { $buy += ,@([double]$level.price, [int]$level.quantity) }
    }
  }

  if ($q.depth.sell) {
    foreach ($level in $q.depth.sell) {
      if ([double]$level.price -gt 0) { $sell += ,@([double]$level.price, [int]$level.quantity) }
    }
  }

  [ordered]@{
    ltp = [double]$q.last_price
    prevClose = [double]$q.ohlc.close
    open = [double]$q.ohlc.open
    high = [double]$q.ohlc.high
    low = [double]$q.ohlc.low
    volume = [int64]$q.volume
    ltq = if ($q.last_quantity) { [int]$q.last_quantity } else { 0 }
    bids = $buy
    asks = $sell
    symbol = $q.symbol
    instrumentKey = $InstrumentKey
    source = "upstox"
    timestamp = $q.timestamp
  }
}

function Update-Quote {
  try {
    $headers = @{
      "Accept" = "application/json"
      "Authorization" = "Bearer $AccessToken"
    }
    $raw = Invoke-RestMethod -Uri $quoteUrl -Headers $headers -Method Get -TimeoutSec 10
    $script:lastQuote = Convert-UpstoxQuote $raw
    $script:lastError = $null
  } catch {
    $script:lastError = $_.Exception.Message
  }
}

function Send-Json($context, $status, $payload) {
  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $context.Response.StatusCode = $status
  $context.Response.ContentType = "application/json; charset=utf-8"
  $context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
  $context.Response.Headers.Add("Cache-Control", "no-store")
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $context.Response.OutputStream.Close()
}

Update-Quote

$timer = [System.Timers.Timer]::new([Math]::Max(1, [int]$PollSeconds) * 1000)
$timer.AutoReset = $true
$timer.add_Elapsed({ Update-Quote })
$timer.Start()

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

Write-Host ""
Write-Host "Upstox bridge running."
Write-Host "Feed URL: http://127.0.0.1:$Port/feed"
Write-Host "Instrument: $InstrumentKey"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $path = $context.Request.Url.AbsolutePath
    if ($path -eq "/feed") {
      if ($script:lastQuote) {
        Send-Json $context 200 $script:lastQuote
      } else {
        Send-Json $context 503 ([ordered]@{ error = "No quote yet"; detail = $script:lastError })
      }
    } elseif ($path -eq "/health") {
      Send-Json $context 200 ([ordered]@{ ok = $true; instrumentKey = $InstrumentKey; error = $script:lastError })
    } else {
      Send-Json $context 404 ([ordered]@{ error = "Not found" })
    }
  }
} finally {
  $timer.Stop()
  $listener.Stop()
}
