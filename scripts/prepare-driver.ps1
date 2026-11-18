$ErrorActionPreference = 'Stop'
# Use Windows' built-in modules even when launched from npm/PowerShell 7.
$env:PSModulePath = "$PSHOME\Modules;$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root '.runtime\downloads'
$destination = Join-Path $root 'build\vendor\driver'
New-Item -ItemType Directory -Path $cache,$destination -Force | Out-Null
$archive = Join-Path $cache 'VDD.Control.25.7.23.zip'
$expected = 'A701F2272E9FCF382849B24F913C6DD07597B3B1116525F2E90182F019609154'
if (-not (Test-Path -LiteralPath $archive)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VDD.Control.25.7.23.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'The upstream driver archive SHA256 does not match the pinned WinGet manifest.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($name in @('MttVDD.inf','MttVDD.dll','mttvdd.cat','vdd_settings.xml')) {
        $entry = @($zip.Entries | Where-Object { ($_.FullName -replace '\\','/') -ieq "SignedDrivers/x86/VDD/$name" })
        if ($entry.Count -ne 1) { throw "Expected exactly one driver file: $name" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry[0], (Join-Path $destination $name), $true)
    }
} finally { $zip.Dispose() }
$signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $destination 'mttvdd.cat')
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike 'CN=SignPath Foundation,*') { throw 'Driver catalog signature verification failed.' }
$hashes = [ordered]@{}
Get-ChildItem -LiteralPath $destination -File | Where-Object Extension -in '.inf','.dll','.cat','.xml' | Sort-Object Name | ForEach-Object { $hashes[$_.Name] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
@{ version='25.7.23'; archiveSha256=$expected; files=$hashes } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $root 'licenses\Virtual-Display-Driver.txt') -Destination (Join-Path $destination 'LICENSE.txt') -Force
Write-Output 'Prepared signed Virtual Display Driver 25.7.23 (x64); no DevCon or driver control application is bundled.'
