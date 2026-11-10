param([string]$OutputRoot)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $workspace 'dist' }
$output = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'uxp\org.psai.canvas.uxp'))
$prefix = $workspace.TrimEnd('\') + '\'
if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay within the workspace.' }
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$files = @(
  'manifest.json', 'index.html', 'css\panel.css',
  'src\main.js', 'src\panel.js', 'src\photoshop-host.js', 'src\imaging-adapter.js', 'src\service-client.js'
)
foreach ($relative in $files) {
  $source = Join-Path $workspace (Join-Path 'hosts\uxp' $relative)
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing UXP source: $relative" }
  $target = Join-Path $output $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}
Write-Output $output
