param([string]$ResultPath = (Join-Path $env:APPDATA 'Sidepad\setup-result.json'),
    [string]$DriverPath = '', [string]$ExecutablePath = '')
$ErrorActionPreference = 'Stop'
# Use Windows' built-in modules even when launched from npm/PowerShell 7.
$env:PSModulePath = "$PSHOME\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
# Invoked only by the install button or an explicit script invocation.
. (Join-Path $PSScriptRoot 'driver-setup.ps1')
$ResultPath = [IO.Path]::GetFullPath($ResultPath)
$workDirectory = Join-Path (Split-Path $ResultPath -Parent) ([guid]::NewGuid().ToString('N'))
$result = Invoke-SidepadDriverSetup -WorkDirectory $workDirectory -DriverPath $DriverPath -ExecutablePath $ExecutablePath
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
$result | ConvertTo-Json -Depth 8
if ($result.rebootRequired) { exit 3010 }
if (-not $result.ok) { exit 1 }
