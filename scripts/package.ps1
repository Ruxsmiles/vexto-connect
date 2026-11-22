# 打包扩展为可上传的 zip（不依赖 npm / 构建工具）。
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "vexto-connect-$version.zip"
$staging = Join-Path $env:TEMP "vexto-connect-package-$version"

$files = @(
  "manifest.json",
  "background.js",
  "common.js",
  "options.html",
  "options.css",
  "options.js",
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

# Build zip with file entries only (no directory entries).
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
