param([int]$Port = 3210)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath)) { throw 'Run npm install first.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid port.' }
# Execute in an administrator PowerShell only if Windows has blocked the app.
# WebRTC media uses dynamic UDP ports; limit both rules to the app, private profile, and local subnet.
$rules = @(
    @{ DisplayName = 'Sidepad LAN signaling'; Protocol = 'TCP'; LocalPort = $Port },
    @{ DisplayName = 'Sidepad LAN video'; Protocol = 'UDP'; LocalPort = 'Any' }
)
foreach ($rule in $rules) {
    Get-NetFirewallRule -DisplayName $rule.DisplayName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule @rule -Direction Inbound -Action Allow -Program $electronPath -Profile Private -RemoteAddress LocalSubnet | Out-Null
}
Write-Output 'Sidepad firewall rules added for private local networks only.'
