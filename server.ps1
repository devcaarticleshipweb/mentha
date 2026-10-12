param(
  [int]$Port = 3001
)

$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$socket = [System.Net.Sockets.Socket]::new(
  [System.Net.Sockets.AddressFamily]::InterNetworkV6,
  [System.Net.Sockets.SocketType]::Stream,
  [System.Net.Sockets.ProtocolType]::Tcp
)
$socket.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::IPv6, [System.Net.Sockets.SocketOptionName]::IPv6Only, $false)
$socket.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::IPv6Any, $Port))
$socket.Listen(100)

Write-Host ""
Write-Host "MENTHA Paper Trade is running."
Write-Host "Open: http://127.0.0.1:$Port/"
Write-Host "Or:   http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

$contentTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
}

function Send-Response($stream, [int]$status, [string]$statusText, [byte[]]$body, [string]$contentType) {
  $header = "HTTP/1.1 $status $statusText`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  $stream.Write($body, 0, $body.Length)
  $stream.Flush()
}

function Send-Redirect($stream, [string]$location) {
  $header = "HTTP/1.1 302 Found`r`nLocation: $location`r`nContent-Length: 0`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  $stream.Flush()
}

try {
  while ($true) {
    $accepted = $socket.Accept()
    try {
      $accepted.ReceiveTimeout = 2000
      $accepted.SendTimeout = 2000
      $stream = [System.Net.Sockets.NetworkStream]::new($accepted, $false)
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 2048, $true)
      $requestLine = $reader.ReadLine()
      if (-not $requestLine) { continue }

      while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line -eq "") { break }
      }

      $parts = $requestLine.Split(" ")
      if ($parts.Length -gt 1 -and $parts[1] -eq "/") {
        Send-Redirect $stream "/?local=1"
        continue
      }

      $urlPath = if ($parts.Length -gt 1) { $parts[1].Split("?")[0] } else { "/" }
      $path = [System.Uri]::UnescapeDataString($urlPath.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($path)) { $path = "index.html" }

      $candidate = Join-Path $root $path
      $fullPath = [System.IO.Path]::GetFullPath($candidate)
      if (-not $fullPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Send-Response $stream 404 "Not Found" ([System.Text.Encoding]::UTF8.GetBytes("Not found")) "text/plain; charset=utf-8"
      } else {
        $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
        $contentType = $contentTypes[$extension]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        Send-Response $stream 200 "OK" ([System.IO.File]::ReadAllBytes($fullPath)) $contentType
      }
    } catch {
      Write-Host "Request error: $($_.Exception.Message)"
    } finally {
      $stream.Close()
      $accepted.Close()
    }
  }
} finally {
  $socket.Close()
}
