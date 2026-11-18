# Registration runs elevated; display configuration runs in the original
# interactive user's session so its desktop/profile is configured.
$script:SidepadScriptDirectory = $PSScriptRoot
function Get-SidepadDriverDevices {
    @(Get-PnpDevice -Class Display -PresentOnly -ErrorAction Stop | Where-Object {
        $ids = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction SilentlyContinue).Data
        $ids -contains 'Root\MttVDD'
    })
}
function Install-SidepadDriverPackage {
    $package = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe'
    $catalog = Join-Path $package 'SignedDrivers\x86\VDD\mttvdd.cat'
    $installer = Join-Path $package 'Dependencies\devcon.exe'
    if (-not ((Test-Path -LiteralPath $catalog) -and (Test-Path -LiteralPath $installer))) {
        $manager = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $manager) { throw 'WinGet is unavailable. Install Virtual Display Driver from its official releases page, then retry.' }
        # Pin the package whose layout, signed binaries and license were checked.
        & $manager.Source install --id VirtualDrivers.Virtual-Display-Driver --version 25.7.23 --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "WinGet installation failed (exit $LASTEXITCODE)." }
    }
    if (-not ((Test-Path -LiteralPath $catalog) -and (Test-Path -LiteralPath $installer))) { throw 'The signed driver package was not found after installation.' }
    return $package
}
function Register-SidepadDriver([string]$PackagePath, [string]$ResultPath, [string]$ExecutablePath = '') {
    $helper = Join-Path $script:SidepadScriptDirectory 'complete-driver-install.ps1'
    # Paths are quoted arguments, never PowerShell source text.
    foreach ($value in @($helper, $PackagePath, $ResultPath, $ExecutablePath)) {
        if ($value.Contains('"')) { throw 'Invalid quote in installation path.' }
    }
    $arguments = '-NoProfile -ExecutionPolicy RemoteSigned -File "{0}" -PackagePath "{1}" -ResultPath "{2}"' -f $helper, $PackagePath, $ResultPath
    if ($ExecutablePath) { $arguments += ' -ExecutablePath "{0}"' -f $ExecutablePath }
    try {
        $process = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } catch {
        if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { throw 'Administrator confirmation was cancelled. No display settings were changed.' }
        throw
    }
    if (-not (Test-Path -LiteralPath $ResultPath)) { throw "Driver registration did not return a result (exit $($process.ExitCode))." }
    $registration = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
    if ($process.ExitCode -ne 0 -or -not $registration.ok) { throw "Driver registration failed: $($registration.error)" }
    return $registration
}
function Set-SidepadVirtualDisplay([string]$ResultPath) {
    & "$PSHOME\powershell.exe" -NoProfile -ExecutionPolicy RemoteSigned -File (Join-Path $script:SidepadScriptDirectory 'configure-virtual-display.ps1') -Apply -Width 1920 -Height 1080 -RefreshRate 60 -WaitSeconds 30 -ResultPath $ResultPath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The driver is installed, but automatic display setup failed. Open Windows Display settings or retry this button.' }
    if (-not (Test-Path -LiteralPath $ResultPath)) { throw 'Display setup did not return a verification result.' }
    return (Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json)
}
function Invoke-SidepadDriverSetup([string]$WorkDirectory, [string]$DriverPath = '', [string]$ExecutablePath = '') {
    $result = [ordered]@{ ok = $false; phase = 'checking-driver'; rebootRequired = $false; alreadyInstalled = $false }
    try {
        New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
        $devices = @(Get-SidepadDriverDevices)
        if ($devices.Count -gt 1) { throw 'Multiple Virtual Display Driver devices were found. Select a single device in Virtual Driver Control first.' }
        if ($devices.Count -eq 1) {
            $result.alreadyInstalled = $true
            if ($devices[0].Status -ne 'OK') { throw 'The existing virtual display driver is not ready. Enable or repair it in Virtual Driver Control, then retry.' }
        }
        if ($devices.Count -eq 0 -or $ExecutablePath) {
            $result.phase = 'installing-package'
            $package = $DriverPath
            if (-not $package -and $devices.Count -eq 0) { $package = Install-SidepadDriverPackage }
            $result.phase = 'registering-driver'
            $registration = Register-SidepadDriver -PackagePath $package -ResultPath (Join-Path $WorkDirectory 'registration.json') -ExecutablePath $ExecutablePath
            if (-not $registration.ok) { throw 'Driver registration was not verified.' }
            $result.rebootRequired = [bool]$registration.rebootRequired
            if ($result.rebootRequired) {
                $result.rebootRequestedAt = [DateTime]::UtcNow.ToString('o')
                $result.phase = 'restart-required'
                throw 'The driver requires a Windows restart. After restarting, click Install and set up driver again to finish 1920 x 1080 setup.'
            }
        }
        $result.phase = 'configuring-display'
        $display = Set-SidepadVirtualDisplay -ResultPath (Join-Path $WorkDirectory 'display.json')
        $virtual = @($display.after | Where-Object { $_.Driver -eq 'Virtual Display Driver' })
        if (-not $display.ok -or $virtual.Count -ne 1 -or -not $virtual[0].Active -or $virtual[0].Primary -or
            $virtual[0].Width -ne 1920 -or $virtual[0].Height -ne 1080 -or $virtual[0].RefreshRate -ne 60) {
            throw 'Could not verify the 1920 x 1080 / 60 Hz extended display.'
        }
        $result.display = $virtual[0]
        $result.phase = 'completed'
        $result.ok = $true
    } catch { $result.error = $_.Exception.Message }
    return $result
}
