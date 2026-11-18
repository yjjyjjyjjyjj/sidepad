param([Parameter(Mandatory=$true)][string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
# Use Windows' built-in modules even when launched from npm/PowerShell 7.
$env:PSModulePath = "$PSHOME\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$helper = Join-Path $PSScriptRoot 'configure-network.ps1'
foreach ($value in @($ExecutablePath,$helper)) { if ($value.Contains('"')) { throw 'Invalid quote in path.' } }
try {
    $arguments = '-NoProfile -ExecutionPolicy RemoteSigned -File "{0}" -ExecutablePath "{1}" -Remove' -f $helper,$ExecutablePath
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $process.ExitCode
} catch { Write-Output $_.Exception.Message; exit 1 }
