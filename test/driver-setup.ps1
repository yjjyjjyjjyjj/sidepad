$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\driver-setup.ps1')
# Exercise sequencing/failures without installing anything or changing displays.
$script:scenario = ''; $script:calls = @()
function Get-SidepadDriverDevices {
    $script:calls += 'inspect'
    if ($script:scenario -eq 'ambiguous') { return @(@{Status='OK'}, @{Status='OK'}) }
    if ($script:scenario -eq 'disabled') { return @{Status='Error'} }
    if ($script:scenario -in @('existing','bad-mode','config-failure')) { return @{Status='OK'} }
    return @()
}
function Install-SidepadDriverPackage {
    $script:calls += 'package'
    if ($script:scenario -eq 'package-failure') { throw 'download failed' }
    return 'C:\test package'
}
function Register-SidepadDriver([string]$PackagePath, [string]$ResultPath) {
    $script:calls += 'register'
    if ($script:scenario -eq 'cancel') { throw 'Administrator confirmation was cancelled.' }
    return @{ok=($script:scenario -ne 'registration-failure'); rebootRequired=($script:scenario -eq 'restart')}
}
function Set-SidepadVirtualDisplay([string]$ResultPath) {
    $script:calls += 'configure'
    if ($script:scenario -eq 'config-failure') { throw 'display mode rejected' }
    return @{ok=$true; after=@(@{Driver='Virtual Display Driver';Active=$true;Primary=$false;Width=1920;Height=1080;RefreshRate=$(if ($script:scenario -eq 'bad-mode') {30} else {60})})}
}
$cases = @(
    @{name='new';ok=$true;phase='completed';calls='inspect,package,register,configure'},
    @{name='existing';ok=$true;phase='completed';calls='inspect,configure'},
    @{name='package-failure';ok=$false;phase='installing-package';calls='inspect,package'},
    @{name='registration-failure';ok=$false;phase='registering-driver';calls='inspect,package,register'},
    @{name='cancel';ok=$false;phase='registering-driver';calls='inspect,package,register'},
    @{name='restart';ok=$false;phase='restart-required';calls='inspect,package,register'},
    @{name='ambiguous';ok=$false;phase='checking-driver';calls='inspect'},
    @{name='disabled';ok=$false;phase='checking-driver';calls='inspect'},
    @{name='config-failure';ok=$false;phase='configuring-display';calls='inspect,configure'},
    @{name='bad-mode';ok=$false;phase='configuring-display';calls='inspect,configure'}
)
foreach ($case in $cases) {
    $script:scenario = $case.name; $script:calls = @()
    $result = Invoke-SidepadDriverSetup -WorkDirectory (Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime\driver-setup-tests')
    if ($result.ok -ne $case.ok -or $result.phase -ne $case.phase -or ($script:calls -join ',') -ne $case.calls) {
        throw "Failed case $($case.name): $($result | ConvertTo-Json -Compress) / $script:calls"
    }
    if (-not $result.ok -and -not $result.error) { throw "Missing error: $($case.name)" }
    if ($result.rebootRequired -ne ($case.name -eq 'restart')) { throw "Bad restart flag: $($case.name)" }
}
Write-Output "$($cases.Count) driver setup scenarios passed without system changes."
