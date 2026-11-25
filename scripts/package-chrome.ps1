# Build the fixed-name Chrome package: dist/vexto-connect-chrome.zip.
$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "package.ps1") -OutputName "vexto-connect-chrome.zip"
