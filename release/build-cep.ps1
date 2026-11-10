param([string]$OutputRoot)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $workspace 'dist' }
$output = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'cep\org.psai.canvas'))
$prefix = $workspace.TrimEnd('\') + '\'
if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay within the workspace.' }
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$files = @(
  'index.html', 'CSXS\manifest.xml', 'css\panel.css',
  'js\CSInterface.js', 'js\host.js', 'js\service-client.js', 'js\panel.js', 'js\main.js',
  'jsx\bridge.jsx', 'jsx\json2.js'
)
foreach ($relative in $files) {
  $source = Join-Path $workspace (Join-Path 'hosts\cep' $relative)
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing CEP source: $relative" }
  $target = Join-Path $output $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}
Copy-Item -LiteralPath (Join-Path $workspace 'hosts\cep\jsx\quick-expand.jsx') -Destination (Join-Path $OutputRoot 'cep\quick-expand.jsx')
Write-Output $output
