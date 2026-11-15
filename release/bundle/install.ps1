[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# 把绿色包安装到当前用户的 CEP 扩展目录。
# runtime 和 service 一起搬过去，安装后就不再依赖解压目录——解压文件夹可以删。

$root = $PSScriptRoot
$target = Join-Path (Join-Path $env:APPDATA 'Adobe\CEP\extensions') 'org.studio.aiimg'

foreach ($required in @('extension\CSXS\manifest.xml', 'runtime\node.exe', 'service\src\main.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $required))) { throw "安装包不完整，缺少 $required。请重新解压后再试。" }
}

if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) {
  Write-Host '请先关闭 Photoshop 再安装——面板文件正被占用，覆盖会失败。' -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'Adobe\CEP\extensions') | Out-Null
New-Item -ItemType Directory -Force -Path $target | Out-Null

# 逐文件覆盖而不是先删目录：升级时能保留用户已经填好的东西，
# 也不会因为某个文件被占用就整个装不上。
Copy-Item -Path (Join-Path $root 'extension\*') -Destination $target -Recurse -Force
foreach ($name in @('runtime', 'service')) {
  Copy-Item -Path (Join-Path $root $name) -Destination (Join-Path $target $name) -Recurse -Force
}

# 相对路径：面板按扩展目录解析，换盘符、换机器都不用改。
$config = [ordered]@{
  node  = 'runtime\node.exe'
  entry = 'service\src\main.js'
  cwd   = 'service'
}
# 必须无 BOM：JSON.parse 遇到 BOM 会直接抛错，面板会当成「没有启动配置」。
[IO.File]::WriteAllText(
  (Join-Path $target 'service-path.json'),
  ($config | ConvertTo-Json -Compress),
  (New-Object System.Text.UTF8Encoding $false)
)

foreach ($version in 8..12) {
  $key = "HKCU:\Software\Adobe\CSXS.$version"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name PlayerDebugMode -PropertyType String -Value '1' -Force | Out-Null
}

Write-Host ''
Write-Host "已安装到：$target" -ForegroundColor Green
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 打开 Photoshop'
Write-Host '  2. 窗口 > 扩展 > AI 图像工坊'
Write-Host '  3. 首次使用点顶部状态条「本地服务未启动 · 点此启动」'
Write-Host '  4. 齿轮 > 生成渠道，填服务地址和 API Key'
Write-Host ''
Write-Host 'API Key 保存在 Windows 凭据管理器，按当前 Windows 用户加密，不会随文件夹拷贝。'
