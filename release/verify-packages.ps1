$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dist = Join-Path $workspace 'dist'
$cep = Join-Path $dist 'cep\org.studio.aiimg'
$uxp = Join-Path $dist 'uxp\org.studio.aiimg.uxp'
$service = Join-Path $dist 'service'
foreach ($path in @($cep, $uxp, $service)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing package: $path" } }
if (-not (Test-Path -LiteralPath (Join-Path $dist 'cep\studio-selection.jsx'))) { throw 'Missing CEP selection shortcut script.' }

$manifest = [xml](Get-Content -LiteralPath (Join-Path $cep 'CSXS\manifest.xml') -Raw)
$uxpManifest = Get-Content -LiteralPath (Join-Path $uxp 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.ExtensionManifest.ExtensionBundleId -ne 'org.studio.aiimg') { throw 'CEP manifest ID mismatch.' }
if ($uxpManifest.host.minVersion -ne '25.0.0') { throw 'UXP minimum version mismatch.' }
# 宿主的 Name 必须是 PHXS（Photoshop 的正式 Host ID），版本区间必须和 manifest 一致。
# 这里原来写的是 PHSP/[19.0,24.9]：既取不到宿主（Name 不匹配 → Version 为空串），
# 版本也对不上，脚本每次都在这里抛错。于是"打包后跑一遍 verify"这道检查名存实亡。
$cepHost = $manifest.ExtensionManifest.ExecutionEnvironment.HostList.Host | Where-Object { $_.Name -eq 'PHXS' }
if (-not $cepHost) { throw 'CEP manifest is missing the PHXS host entry.' }
if ($cepHost.Version -ne '[11.0,99.9]') { throw "CEP version range mismatch: $($cepHost.Version)" }
if ($uxpManifest.requiredPermissions.network.domains -notcontains 'http://127.0.0.1:32145') { throw 'UXP loopback permission missing.' }

foreach ($file in @('index.html','js\CSInterface.js','js\host.js','js\panel.js','js\channel-view.js','js\local-service.js','js\service-client.js','js\main.js','jsx\bridge.jsx','jsx\json2.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $cep $file))) { throw "Missing CEP file: $file" }
}
foreach ($file in @('index.html','src\main.js','src\panel.js','src\channel-view.js','src\photoshop-host.js','src\imaging-adapter.js','src\work-area.js','src\expansion-layout.js','src\service-client.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $uxp $file))) { throw "Missing UXP file: $file" }
}
foreach ($file in @('package.json','package-lock.json','src\main.js','src\server.js','src\channel-store.js','src\client-token.js','src\jobs.js','src\ttl-map.js','scripts\wincred.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $service $file))) { throw "Missing service file: $file" }
}
if (-not (Test-Path -LiteralPath (Join-Path $service 'node_modules\sharp'))) { throw 'Packaged service dependencies are missing. Run npm ci in service first.' }
foreach ($js in @((Join-Path $cep 'js\host.js'), (Join-Path $cep 'js\panel.js'), (Join-Path $cep 'js\channel-view.js'), (Join-Path $cep 'js\local-service.js'), (Join-Path $cep 'js\service-client.js'), (Join-Path $cep 'js\main.js'), (Join-Path $uxp 'src\main.js'), (Join-Path $uxp 'src\panel.js'), (Join-Path $uxp 'src\channel-view.js'), (Join-Path $uxp 'src\photoshop-host.js'), (Join-Path $uxp 'src\work-area.js'), (Join-Path $uxp 'src\expansion-layout.js'), (Join-Path $uxp 'src\service-client.js'), (Join-Path $service 'src\main.js'), (Join-Path $service 'src\channel-store.js'), (Join-Path $service 'src\ttl-map.js'))) {
  & node --check $js
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failed: $js" }
}
Write-Output 'CEP, UXP and local service package checks passed.'
