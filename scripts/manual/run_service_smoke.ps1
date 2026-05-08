#requires -RunAsAdministrator
param(
    [int]$Port = 13602
)

$ErrorActionPreference = 'Stop'

Write-Host "=== x64dbg-mcp service smoke (port $Port) ==="

Write-Host "[1/6] npm run build"
npm run build | Out-Null

Write-Host "[2/6] service install"
node dist/server.js service install --port $Port
if ($LASTEXITCODE -ne 0) { throw "install failed: $LASTEXITCODE" }

Write-Host "[3/6] service start"
node dist/server.js service start
if ($LASTEXITCODE -ne 0) { throw "start failed: $LASTEXITCODE" }

Start-Sleep -Seconds 3

Write-Host "[4/6] service status"
node dist/server.js service status
if ($LASTEXITCODE -ne 0) { throw "status failed: $LASTEXITCODE" }

Write-Host "[5/6] HTTP initialize round-trip"
$body = @{
    jsonrpc = '2.0'
    id = 1
    method = 'initialize'
    params = @{
        protocolVersion = '2024-11-05'
        capabilities = @{}
        clientInfo = @{ name = 'smoke'; version = '0' }
    }
} | ConvertTo-Json -Depth 10
$response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/mcp" -Method Post -Body $body -ContentType 'application/json' -Headers @{ Accept = 'application/json, text/event-stream' }
if (-not $response) { throw "no response from /mcp" }
Write-Host "  initialize OK"

Write-Host "[6/6] service stop and uninstall"
node dist/server.js service stop
node dist/server.js service uninstall

Write-Host "=== smoke OK ==="
