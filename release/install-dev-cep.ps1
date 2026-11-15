param([ValidateSet(8, 9, 10, 11, 12)][int]$CsxsVersion = 8)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $workspace 'dist\cep\org.studio.aiimg'
if (-not (Test-Path -LiteralPath (Join-Path $source 'CSXS\manifest.xml'))) { throw 'Build the CEP package first.' }
$appData = [IO.Path]::GetFullPath($env:APPDATA)
$extensions = [IO.Path]::GetFullPath((Join-Path $appData 'Adobe\CEP\extensions'))
if (-not $extensions.StartsWith($appData.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected Adobe extension directory.' }
$target = Join-Path $extensions 'org.studio.aiimg'
if (Test-Path -LiteralPath $target) { throw "Extension already exists: $target. Remove or rename it manually before reinstalling." }
New-Item -ItemType Directory -Force -Path $extensions | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse
$key = "HKCU:\Software\Adobe\CSXS.$CsxsVersion"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name PlayerDebugMode -PropertyType String -Value '1' -Force | Out-Null

# 面板靠这个文件知道「用哪个 node、跑哪个入口」，从而自己把服务拉起来，
# 用户不必再开终端、不必再抄连接码。开发安装指向项目目录 + 系统 node；
# 绿色包构建时改写成包内相对路径（runtime\node.exe + service\src\main.js）。
$nodePath = $null
# 优先用用户自己安装的 Node，而不是把开发机的私有路径写死进配置：
# 换一台电脑、或工装环境变动时，标准安装位置的存活率最高。
foreach ($candidate in @(
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $nodePath = $candidate; break }
}
if (-not $nodePath) {
  $nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if ($nodeCommand) { $nodePath = $nodeCommand.Source }
}
if (-not $nodePath) {
  Write-Warning '没有找到 node.exe，面板将无法自动启动本地服务（仍可手动启动后填写连接码）。'
} else {
  $launcher = [ordered]@{
    node  = $nodePath
    entry = (Join-Path $workspace 'service\src\main.js')
    cwd   = (Join-Path $workspace 'service')
  }
  $json = $launcher | ConvertTo-Json -Compress
  # 必须无 BOM：JSON.parse 遇到 BOM 会直接抛错，面板会当成「没有启动配置」。
  [IO.File]::WriteAllText((Join-Path $target 'service-path.json'), $json, (New-Object System.Text.UTF8Encoding $false))
  Write-Output "启动配置已写入：$nodePath"
}
Write-Output "CEP 开发版已安装到 $target。重启 Photoshop，打开 窗口 > 扩展 > AI 图像工坊。"
