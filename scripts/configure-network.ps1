param([Parameter(Mandatory=$true)][string]$ExecutablePath, [switch]$Remove)
$ErrorActionPreference = 'Stop'
# Use Windows' built-in modules even when launched from npm/PowerShell 7.
$env:PSModulePath = "$PSHOME\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$path = [IO.Path]::GetFullPath($ExecutablePath)
if ([IO.Path]::GetFileName($path) -ne 'Sidepad.exe') { throw 'Expected the installed Sidepad executable.' }
if (-not $Remove -and -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Sidepad.exe was not found.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $id = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($path.ToLowerInvariant()))[0..7] | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
foreach ($protocol in @('TCP','UDP')) {
    $name = "Sidepad-$id-$protocol"
    $existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($Remove) { if ($existing) { $existing | Remove-NetFirewallRule }; continue }
    if ($existing) { $existing | Remove-NetFirewallRule }
    # HTTP signaling and dynamic WebRTC ports, limited to this executable and LAN.
    New-NetFirewallRule -Name $name -DisplayName "Sidepad local network ($protocol)" -Group 'Sidepad' -Direction Inbound -Action Allow -Program $path -Protocol $protocol -Profile Private -RemoteAddress LocalSubnet | Out-Null
}
