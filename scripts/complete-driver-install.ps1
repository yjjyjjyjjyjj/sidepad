param(
    [string]$PackagePath = (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe'),
    [string]$ResultPath = (Join-Path $env:LOCALAPPDATA 'Sidepad\driver-install-result.json'),
    [string]$ExecutablePath = ''
)
$ErrorActionPreference = 'Stop'
# Use Windows' built-in modules even when launched from npm/PowerShell 7.
$env:PSModulePath = "$PSHOME\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$result = @{ ok = $false; phase = 'initializing'; rebootRequired = $false }
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script needs an administrator PowerShell to register the display driver.'
    }
    $result.phase = 'checking-existing-devices'
    $existing = @(Get-PnpDevice -Class Display -PresentOnly | Where-Object {
        $ids = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction SilentlyContinue).Data
        $ids -contains 'Root\MttVDD'
    })
    if ($existing.Count -gt 1) { throw 'Multiple virtual driver devices found; refusing to add another.' }
    if ($existing.Count -eq 0) {
        if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This driver package supports Intel/AMD 64-bit Windows only.' }
        $source = $PackagePath
        if (-not (Test-Path -LiteralPath (Join-Path $source 'MttVDD.inf'))) { $source = Join-Path $PackagePath 'SignedDrivers\x86\VDD' }
        $catalogSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $source 'mttvdd.cat')
        if ($catalogSignature.Status -ne 'Valid' -or $catalogSignature.SignerCertificate.Subject -notlike 'CN=SignPath Foundation,*') { throw 'Driver catalog signature validation failed.' }
        $manifestPath = Join-Path $source 'manifest.json'
        if (Test-Path -LiteralPath $manifestPath) {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            foreach ($name in @('MttVDD.inf','MttVDD.dll','mttvdd.cat','vdd_settings.xml')) {
                if ((Get-FileHash -LiteralPath (Join-Path $source $name) -Algorithm SHA256).Hash -ne $manifest.files.$name) { throw "Driver payload hash mismatch: $name" }
            }
        }
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
        Add-Type -Path (Join-Path $PSScriptRoot 'NativeDriver.cs')
        $result.rebootRequired = [SidepadNativeDriver]::Install((Join-Path $destination 'MttVDD.inf'))
    } else {
        $result.alreadyInstalled = $true
    }
    if ($ExecutablePath) {
        $result.phase = 'configuring-local-network'
        & (Join-Path $PSScriptRoot 'configure-network.ps1') -ExecutablePath $ExecutablePath
        $result.networkConfigured = $true
    }
    $result.phase = 'completed'
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    New-Item -ItemType Directory -Path (Split-Path ([IO.Path]::GetFullPath($ResultPath)) -Parent) -Force | Out-Null
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
if (-not $result.ok) { exit 1 }
