param(
    [string]$ResultPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime\driver-install-result.json')
)
$ErrorActionPreference = 'Stop'
$result = @{ ok = $false; phase = 'initializing'; rebootRequired = $false }
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script needs an administrator PowerShell to register the display driver.'
    }
    $package = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe'
    $source = Join-Path $package 'SignedDrivers\x86\VDD'
    $installer = Join-Path $package 'Dependencies\devcon.exe'
    $catalog = Join-Path $source 'mttvdd.cat'
    $catalogSignature = Get-AuthenticodeSignature -LiteralPath $catalog
    $installerSignature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($catalogSignature.Status -ne 'Valid' -or $catalogSignature.SignerCertificate.Subject -notlike 'CN=SignPath Foundation,*') { throw 'Driver catalog signature validation failed.' }
    if ($installerSignature.Status -ne 'Valid' -or $installerSignature.SignerCertificate.Subject -notlike 'CN=Microsoft Corporation,*') { throw 'Microsoft device installer signature validation failed.' }
    $result.phase = 'checking-existing-devices'
    $existing = @(Get-PnpDevice -Class Display -PresentOnly | Where-Object {
        $ids = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction SilentlyContinue).Data
        $ids -contains 'Root\MttVDD'
    })
    if ($existing.Count -eq 0) {
        $destination = 'C:\VirtualDisplayDriver'
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        foreach ($name in @('MttVDD.inf','MttVDD.dll','mttvdd.cat')) {
            Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Force
        }
        $settingsPath = Join-Path $destination 'vdd_settings.xml'
        if (-not (Test-Path -LiteralPath $settingsPath)) {
            Copy-Item -LiteralPath (Join-Path $source 'vdd_settings.xml') -Destination $settingsPath
        }
        # Leave certificate stores and Windows driver trust policy unchanged.
        # Windows may ask the user to confirm this publisher during installation.
        $result.phase = 'installing-root-display-device'
        $output = & $installer install (Join-Path $destination 'MttVDD.inf') 'Root\MttVDD' 2>&1
        $code = $LASTEXITCODE
        $result.installerOutput = ($output | Out-String).Trim()
        $result.installerExitCode = $code
        if ($code -notin @(0,1)) { throw "Device installer failed with exit code $code." }
        $result.rebootRequired = $code -eq 1
    } else {
        $result.alreadyInstalled = $true
    }
    $result.phase = 'completed'
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
if (-not $result.ok) { exit 1 }
