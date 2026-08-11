param(
    [string]$PhotoshopRoot = "$env:ProgramFiles\Adobe\Adobe Photoshop 2026"
)

$ErrorActionPreference = 'Stop'

$pluginsRoot = Join-Path $PhotoshopRoot 'Plug-ins'
$destination = Join-Path $pluginsRoot 'AiImagePS'
if (-not (Test-Path -LiteralPath $pluginsRoot -PathType Container)) {
    throw "Не знайдено папку Photoshop Plug-ins: $pluginsRoot"
}
if ((Split-Path -Leaf $destination) -ne 'AiImagePS') {
    throw "Захисна перевірка шляху не пройшла: $destination"
}

$runtimeFiles = @(
    'manifest.json', 'index.html', 'style.css',
    'main.js', 'auth.js', 'cache.js', 'capture.js', 'geometry.js', 'layer-tree.js',
    'history.js', 'place.js', 'png.js', 'presets.js', 'usage.js'
)
$runtimeDirs = @('icons', 'providers')

if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination | Out-Null

foreach ($name in $runtimeFiles) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Відсутній runtime-файл: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name)
}
foreach ($name in $runtimeDirs) {
    $source = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Відсутня runtime-папка: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name) -Recurse
}

Write-Host "Встановлено: $destination"
Write-Host 'Перезапустіть Photoshop і відкрийте Plugins -> AI Image.'
