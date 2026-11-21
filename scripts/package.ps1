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

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

Write-Output $zip
