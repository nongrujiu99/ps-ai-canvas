# PS AI 本地服务

首版支持 Windows。需要 Node.js 20.9 或更新版本。服务只监听 `127.0.0.1:32145`，供 Photoshop CEP / UXP 面板使用；阿里云 API Key 保存在当前 Windows 用户的凭据管理器，目标名为 `PSAI.Canvas.Bailian`。

## 启动

在源码目录执行：

```powershell
npm ci
npm start
```

从 `release/build-service.ps1` 生成的 `dist/service` 包含本机 Windows 依赖，可以直接执行 `node src/main.js`；移到其他架构时先重新运行 `npm ci`。

若 32145 已占用，可以设置 `PSAI_PORT`，同时修改面板的服务端口。服务需要在使用面板时保持运行。服务首次启动时生成一条本机连接码，保存在当前用户的 `%LOCALAPPDATA%\PSAI Canvas\client-token`，启动窗口也会显示；先在面板“设置”中输入连接码，再输入北京地域的百炼 API Key 和业务空间 ID。连接码不要公开。切勿在命令行、截图或工单中粘贴真实 Key。

## 本地接口

所有 `/v1` 请求须带 `X-PSAI-Client: ps-ai-plugin` 和 `X-PSAI-Token: <本机连接码>`。JSON 请求须带 `Content-Type: application/json`。存在 `Origin` 的请求只接受插件允许的来源。`GET /health` 不需要标识。

- `POST /v1/inspect`：非付费选区检查。
- `POST /v1/jobs`：提交 `editMasked`、`editWhole`、`expand`、`generate` 任务；默认仅生成 1 张。此调用可能产生阿里云费用。
- `GET /v1/jobs/{jobId}`：查询任务，不会重复提交付费任务。
- `GET /v1/results/{jobId}/{index}`：读取本地结果 PNG；附加 `/raw` 返回 RGBA 字节。
- `DELETE /v1/jobs/{jobId}`：停止本地等待；不能撤销已提交的云端任务。
- `GET /v1/settings/status`、`PUT /v1/settings/key`：查看配置状态、保存 Key。状态响应只包含配置状态与业务空间 ID。

示例（虚拟值）：

```powershell
$headers = @{ 'X-PSAI-Client' = 'ps-ai-plugin'; 'X-PSAI-Token' = (Get-Content "$env:LOCALAPPDATA\PSAI Canvas\client-token" -Raw).Trim() }
Invoke-RestMethod http://127.0.0.1:32145/v1/settings/status -Headers $headers
```

编辑使用 `wanx2.1-imageedit`，文生图使用 `wan2.7-image`。网络调用与 Photoshop 回填仍需真实安装环境验证；自动测试用模拟响应，不会调用付费接口。
