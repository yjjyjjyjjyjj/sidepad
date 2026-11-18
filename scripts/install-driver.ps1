param([string]$ResultPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime\driver-setup-result.json'))
$ErrorActionPreference = 'Stop'
# Invoked only by the install button or an explicit script invocation.
. (Join-Path $PSScriptRoot 'driver-setup.ps1')
$ResultPath = [IO.Path]::GetFullPath($ResultPath)
$workDirectory = Join-Path (Split-Path $ResultPath -Parent) ([guid]::NewGuid().ToString('N'))
$result = Invoke-SidepadDriverSetup -WorkDirectory $workDirectory
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
$result | ConvertTo-Json -Depth 8
if (-not $result.ok) { exit 1 }
