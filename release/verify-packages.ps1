$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dist = Join-Path $workspace 'dist'
$cep = Join-Path $dist 'cep\org.psai.canvas'
$uxp = Join-Path $dist 'uxp\org.psai.canvas.uxp'
$service = Join-Path $dist 'service'
foreach ($path in @($cep, $uxp, $service)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing package: $path" } }

$manifest = [xml](Get-Content -LiteralPath (Join-Path $cep 'CSXS\manifest.xml') -Raw)
$uxpManifest = Get-Content -LiteralPath (Join-Path $uxp 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.ExtensionManifest.ExtensionBundleId -ne 'org.psai.canvas') { throw 'CEP manifest ID mismatch.' }
if ($uxpManifest.host.minVersion -ne '25.0.0') { throw 'UXP minimum version mismatch.' }
$cepHost = $manifest.ExtensionManifest.ExecutionEnvironment.HostList.Host | Where-Object { $_.Name -eq 'PHSP' }
if ($cepHost.Version -ne '[19.0,24.9]') { throw 'CEP version range mismatch.' }
if ($uxpManifest.requiredPermissions.network.domains -notcontains 'http://127.0.0.1:32145') { throw 'UXP loopback permission missing.' }

foreach ($file in @('index.html','js\CSInterface.js','js\host.js','js\panel.js','js\service-client.js','js\main.js','jsx\bridge.jsx','jsx\json2.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $cep $file))) { throw "Missing CEP file: $file" }
}
foreach ($file in @('index.html','src\main.js','src\panel.js','src\photoshop-host.js','src\imaging-adapter.js','src\service-client.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $uxp $file))) { throw "Missing UXP file: $file" }
}
foreach ($file in @('package.json','package-lock.json','src\main.js','src\server.js','src\client-token.js','scripts\wincred.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $service $file))) { throw "Missing service file: $file" }
}
if (-not (Test-Path -LiteralPath (Join-Path $service 'node_modules\sharp'))) { throw 'Packaged service dependencies are missing. Run npm ci in service first.' }
foreach ($js in @((Join-Path $cep 'js\host.js'), (Join-Path $cep 'js\panel.js'), (Join-Path $cep 'js\service-client.js'), (Join-Path $cep 'js\main.js'), (Join-Path $uxp 'src\main.js'), (Join-Path $uxp 'src\panel.js'), (Join-Path $uxp 'src\photoshop-host.js'), (Join-Path $uxp 'src\service-client.js'), (Join-Path $service 'src\main.js'))) {
  & node --check $js
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failed: $js" }
}
Write-Output 'CEP, UXP and local service package checks passed.'
