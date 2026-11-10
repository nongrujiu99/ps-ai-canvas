param([string]$OutputRoot)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $workspace 'dist' }
$output = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'service'))
$prefix = $workspace.TrimEnd('\') + '\'
if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay within the workspace.' }
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath (Join-Path $workspace 'service\src') -Destination (Join-Path $output 'src') -Recurse
Copy-Item -LiteralPath (Join-Path $workspace 'service\scripts') -Destination (Join-Path $output 'scripts') -Recurse
foreach ($name in @('package.json', 'package-lock.json', 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $workspace (Join-Path 'service' $name)) -Destination (Join-Path $output $name)
}
$dependencies = Join-Path $workspace 'service\node_modules'
if (Test-Path -LiteralPath (Join-Path $dependencies 'sharp')) {
  Copy-Item -LiteralPath $dependencies -Destination (Join-Path $output 'node_modules') -Recurse
}
Write-Output $output
