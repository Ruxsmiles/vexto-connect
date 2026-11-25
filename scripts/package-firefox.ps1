# Build the Firefox package (event page background, no Chrome-only permissions).
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "vexto-connect-firefox-$version.zip"
$staging = Join-Path $env:TEMP "vexto-connect-firefox-$version"

# Validate the locales first so a broken messages.json never gets packaged.
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node (Join-Path $PSScriptRoot "check-i18n.mjs")
  if ($LASTEXITCODE -ne 0) { throw "i18n check failed; packaging aborted." }
} else {
  Write-Warning "node not found; skipping the i18n check."
}

$files = @(
  "background.js",
  "common.js",
  "options.html",
  "options.css",
  "options.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "README.md",
  "LICENSE"
)

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

foreach ($file in $files) {
  Copy-Item (Join-Path $root $file) (Join-Path $staging $file)
}
Copy-Item (Join-Path $root "icons") (Join-Path $staging "icons") -Recurse
Copy-Item (Join-Path $root "assets") (Join-Path $staging "assets") -Recurse
Copy-Item (Join-Path $root "_locales") (Join-Path $staging "_locales") -Recurse

# Firefox manifest is maintained separately: event page, gecko id, no downloads.ui.
$ffPath = Join-Path -Path $root -ChildPath "manifest.firefox.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$ffText = [System.IO.File]::ReadAllText($ffPath, $utf8)
$ffText = $ffText -replace '"version":\s*"[^"]+"', ('"version": "' + $version + '"')
[System.IO.File]::WriteAllText((Join-Path $staging "manifest.json"), $ffText, $utf8)

# Build zip with file entries only; Firefox cannot serve files under directory entries.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, "Create")
try {
  Get-ChildItem -Path $staging -Recurse -File | ForEach-Object {
    $entryName = $_.FullName.Substring($staging.Length + 1).Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName) | Out-Null
  }
} finally {
  $archive.Dispose()
}
Remove-Item $staging -Recurse -Force

Write-Output $zip
