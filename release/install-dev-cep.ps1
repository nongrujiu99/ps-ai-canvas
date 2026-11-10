param([ValidateSet(8, 9, 10, 11, 12)][int]$CsxsVersion = 8)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $workspace 'dist\cep\org.psai.canvas'
if (-not (Test-Path -LiteralPath (Join-Path $source 'CSXS\manifest.xml'))) { throw 'Build the CEP package first.' }
$appData = [IO.Path]::GetFullPath($env:APPDATA)
$extensions = [IO.Path]::GetFullPath((Join-Path $appData 'Adobe\CEP\extensions'))
if (-not $extensions.StartsWith($appData.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected Adobe extension directory.' }
$target = Join-Path $extensions 'org.psai.canvas'
if (Test-Path -LiteralPath $target) { throw "Extension already exists: $target. Remove or rename it manually before reinstalling." }
New-Item -ItemType Directory -Force -Path $extensions | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse
$key = "HKCU:\Software\Adobe\CSXS.$CsxsVersion"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name PlayerDebugMode -PropertyType String -Value '1' -Force | Out-Null
Write-Output "CEP 开发版已安装到 $target。重启 Photoshop，打开 窗口 > 扩展 > PS AI 画布。"
