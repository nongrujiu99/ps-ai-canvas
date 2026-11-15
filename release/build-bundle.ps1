param([string]$OutputRoot)

# 绿色包：解压即用，目标机不需要装 Node、不需要开终端。
#
# 结构：
#   studio\
#     install.bat          双击这个
#     install.ps1
#     runtime\node.exe     便携 Node，面板启动服务时用它
#     service\             本地服务（含 node_modules 与 sharp 二进制）
#     extension\           CEP 面板
#
# 安装后 runtime 与 service 会一起进 APPDATA 的扩展目录，面板的
# service-path.json 写成相对路径，换盘符、换机器都不用改。

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputRoot) { $OutputRoot = Join-Path $workspace 'dist' }
$output = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'studio'))
$prefix = $workspace.TrimEnd('\') + '\'
if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay within the workspace.' }

# 先重建子产物，避免把上一次的旧面板/旧服务打进去。
& (Join-Path $PSScriptRoot 'build-cep.ps1') | Out-Null
& (Join-Path $PSScriptRoot 'build-service.ps1') | Out-Null

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$nodeExe = $null
foreach ($candidate in @(
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $nodeExe = $candidate; break }
}
if (-not $nodeExe) {
  $command = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if ($command) { $nodeExe = $command.Source }
}
if (-not $nodeExe) { throw '找不到 node.exe，无法制作绿色包（先安装 Node.js 再构建）。' }

New-Item -ItemType Directory -Force -Path (Join-Path $output 'runtime') | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $output 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $workspace 'dist\cep\org.studio.aiimg') -Destination (Join-Path $output 'extension') -Recurse
Copy-Item -LiteralPath (Join-Path $workspace 'dist\service') -Destination (Join-Path $output 'service') -Recurse

# 渠道配置与 Key 不进包：Key 在 Windows 凭据库里（按用户加密，本来也搬不走），
# openai.env 是开发机的东西，带过去只会让对面误以为已经配好了。
foreach ($leak in @('service\openai.env', 'service\channel.json')) {
  $path = Join-Path $output $leak
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bundle\install.ps1') -Destination (Join-Path $output 'install.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bundle\install.bat') -Destination (Join-Path $output 'install.bat')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bundle\README.txt') -Destination (Join-Path $output 'README.txt')

$size = (Get-ChildItem -LiteralPath $output -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Output ("{0}  ({1:N0} MB)" -f $output, $size)
