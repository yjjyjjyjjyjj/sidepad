$ErrorActionPreference = 'Stop'
# Run only when the user clicks Install driver in Sidepad or invokes this script.
# WinGet verifies the installer hash and Windows handles the elevation prompt.
$manager = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $manager) { throw 'WinGet is unavailable. Install Virtual Display Driver from its official GitHub releases page.' }
& $manager.Source install --id VirtualDrivers.Virtual-Display-Driver --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw "WinGet exited with code $LASTEXITCODE. If already installed, open Windows Display settings and enable Extend." }
