# AI 图像工坊

Windows Photoshop 的 AI 选区编辑、扩图与文生图面板。面板在 Photoshop 里运行，图像处理交给你本机的 Node.js 服务，服务再把任务转发给云端的图像模型；结果先回面板预览，确认后才写回 PSD。

- **PS 2018–2023**：CEP 面板，可一键安装。
- **PS 2024 及更新**：UXP 面板，需要用 UXP Developer Tool 加载。
- **生成渠道**：阿里云百炼、OpenAI 兼容中转 / Vertex AI Express、Black Forest Labs FLUX。
- **API Key**：存在 Windows 凭据管理器，按当前 Windows 用户加密，不写进配置文件，也不随安装包拷贝。

> 这是原型项目。CEP/UXP 在真实 Photoshop 中的加载、蒙版羽化与图层回填尚未逐版本实测；详见 [兼容性记录](docs/compatibility-matrix.md)。生成请求可能产生费用，请先配置渠道并确认单价。

## 目录

- [环境要求](#环境要求)
- [从 GitHub 安装](#从-github-安装)
  - [CEP 一键安装](#cep-一键安装ps-20182023)
  - [分步安装](#分步安装)
  - [UXP 安装](#uxp-安装ps-2024)
- [首次使用](#首次使用)
- [使用教程](#使用教程)
- [常见问题](#常见问题)
- [开发者说明](#开发者说明)
- [实现约定](#实现约定)
- [边界与参考](#边界与参考)

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Photoshop | CC 2018（19.x）或更新；2018–2023 用 CEP，2024+ 用 UXP |
| 一键安装 | Node.js 20.9+、Git for Windows、PowerShell 5.1（系统自带） |
| 已安装的绿色包 | 自带 Node 运行时与本地服务，目标机不需要另装 Node |
| 账号 | 至少一个图像渠道的 API Key；百炼还需要北京地域业务空间 ID |
| 文档 | RGB、8 位；选区编辑与扩图需要有活动文档 |

一键安装脚本会先构建绿色包，因此**构建时**需要 Node.js 和 Git；安装完成后的扩展目录里已经带上 `runtime/node.exe` 和 `service/`，之后可以删掉临时源码目录。

## 从 GitHub 安装

仓库地址：<https://github.com/nongrujiu99/ps-ai-canvas>

### CEP 一键安装（PS 2018–2023）

1. 关闭 Photoshop。安装脚本会检查进程，开着 PS 会直接退出。
2. 打开 **PowerShell**（不是 cmd），粘贴下面这一整行后回车：

```powershell
$ErrorActionPreference='Stop'; $src=Join-Path $env:TEMP ('ps-ai-canvas-'+[guid]::NewGuid().ToString('N').Substring(0,8)); git clone --depth 1 https://github.com/nongrujiu99/ps-ai-canvas.git "$src"; if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }; $svc=Join-Path $src 'service'; npm --prefix "$svc" ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }; $build=Join-Path $src 'release\build-bundle.ps1'; powershell -NoProfile -ExecutionPolicy Bypass -File "$build"; if ($LASTEXITCODE -ne 0) { throw 'build failed' }; $install=Join-Path $src 'dist\studio\install.ps1'; powershell -NoProfile -ExecutionPolicy Bypass -File "$install"; if ($LASTEXITCODE -ne 0) { throw 'install failed' }; Write-Host "安装完成，源码临时目录：$src"
```

这条命令依次做四件事：克隆仓库 → 安装服务依赖 → 构建带 Node 运行时的绿色包 → 安装 CEP 扩展到当前用户。成功后会打印安装位置：`%APPDATA%\Adobe\CEP\extensions\org.studio.aiimg`。临时源码目录可以删，不影响已安装的扩展。

3. 打开 Photoshop，选择 **窗口 > 扩展 > AI 图像工坊**。若面板没有出现，重启 Photoshop 后重试。

一键安装会为 CSXS 8–12 写入 `PlayerDebugMode=1`，让未签名的 CEP 扩展能加载。仓库不包含 Adobe 签名证书，因此这里不提供 ZXP 正式签名包。

### 分步安装

如果一键命令中的某一步失败，或你想保留源码，按需执行：

```powershell
git clone https://github.com/nongrujiu99/ps-ai-canvas.git
cd ps-ai-canvas
npm --prefix service ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\release\build-bundle.ps1
```

构建结果在 `dist/studio/`：

```text
dist/studio/
├── install.bat          双击这个
├── install.ps1
├── README.txt
├── runtime/node.exe     面板用来启动服务的便携 Node
├── service/             本地服务（含 sharp 二进制）
└── extension/           CEP 面板
```

关掉 Photoshop，双击 `dist/studio/install.bat`，再打开 **窗口 > 扩展 > AI 图像工坊**。

也可以只构建开发加载用的 CEP 包：`powershell -File .\release\build-cep.ps1`，然后按 Photoshop 版本安装：

```powershell
# PS 2018（19.x）
powershell -ExecutionPolicy Bypass -File .\release\install-dev-cep.ps1 -CsxsVersion 8
# PS 2019–2020（20–21.x）：-CsxsVersion 9
# PS 2021（22.x）：-CsxsVersion 10
# PS 2022–2023（23–24.x）：-CsxsVersion 11
```

开发安装会把扩展放进同一个 `%APPDATA%` 目录，但 `service-path.json` 指向你克隆的源码目录；移动或删除源码后，面板将拉不起服务。已存在同名扩展时该脚本会停止，需先手动移走旧目录。

### UXP 安装（PS 2024+）

UXP 不能通过上面的 CEP 安装脚本加载，也没有一键入口：

1. 安装并打开 **UXP Developer Tool**，在 Photoshop 与工具中启用开发者模式。
2. 构建 UXP 包：`powershell -NoProfile -ExecutionPolicy Bypass -File .\release\build-uxp.ps1`。
3. 在 UXP Developer Tool 中选择 **Add Plugin**，打开 `dist/uxp/org.studio.aiimg.uxp/manifest.json`，点 **Load**。
4. 在 Photoshop 的 **插件** 菜单打开 **AI 图像工坊**。

UXP 面板不会自动启动本地服务。另开一个终端，在克隆目录执行：

```powershell
cd service
npm ci
node src/main.js
```

记下启动窗口显示的 **Local connection code**（本机连接码），在面板 **设置 > 本地服务** 里填入并点「使用此连接码」。服务窗口要保持打开；服务只监听 `127.0.0.1:32145`。

## 首次使用

以 CEP 绿色包为例：

1. **确认服务已启动。** 面板顶部状态条显示「本地服务未启动 · 点此启动」时点一下，绿色包会用自带 Node 直接拉起服务，连接码自动读取。直接点「生成预览」也会尝试拉起。
2. **打开设置（右上角齿轮）> 生成渠道**，按你手上的 Key 选一个渠道：

   | 渠道 | 需要填写 | 说明 |
   | --- | --- | --- |
   | 百炼 | 业务空间 ID、API Key | 北京地域百炼；扩图默认 `qwen-image-3.0-pro`，文生图 `wan2.7-image`，选区编辑走 `wanx2.1-imageedit` |
   | 第三方 API | 服务地址（以 `/v1` 结尾）、API Key、模型、尺寸模式 | OpenAI 兼容中转；填 Vertex AI 地址会自动切换 Vertex 预设模型。`AQ.` 开头的 Key 是 Express Mode，连通探针不会去调 `/models` |
   | FLUX | API Key、文生图模型 | Black Forest Labs；扩图和选区编辑走各自的专用端点，模型只用于文生图 |

3. 点 **测试连通** 先验 Key、地址和模型名，再点 **保存**。测试连通只回答「地址通不通、Key 有没有效、模型名在不在列表里」，不验证余额、出图权限和模型此刻是否可用；通过不等于一定能出图。
4. 回主界面，打开一张 RGB 8 位文档，选一种模式开始生成。

API Key 保存后不会在面板回显。它存在当前 Windows 用户的凭据管理器里（百炼 `Studio.AiImg.Bailian`、第三方 `Studio.AiImg.ThirdParty`、FLUX `Studio.AiImg.BFL`），换电脑或重装系统后要重新填一次。

## 使用教程

面板顶部依次是：文档状态、渠道信号行、模式切换（**选区编辑 / 扩图 / 生成**）、画面描述、短参数（候选数量、随机种子，生成模式还有输出尺寸）、「更多选项」和「生成预览」。

### 选区编辑

1. 在 Photoshop 里框选要修改的区域。
2. 保持「选区编辑」，在「画面描述」里写需求，例如「把选区里的杯子换成白色陶瓷花瓶」。
3. 描述留空时走自然补全：服务端会按周围内容填充；有描述时按指令局部重绘。
4. 想重画整幅画面，展开 **更多选项**，勾选「整张画面重绘」，并按需调「修改幅度」。
5. 点 **生成预览**。结果先出现在候选卡片区，原 PSD 不会被改动；满意后点卡片上的 **应用候选**，结果作为新像素图层贴回，选区灰度用作图层蒙版。

选区同时压住照片和透明区时会被判为「不明确」，面板会要求只框照片内部；没有选区时不会提交付费请求。

### 扩图

两种方式：

- **透明边推导（推荐）**：先在 Photoshop 里把画布向要扩的方向拉大，再框选新增的透明边缘。面板会从透明边自动推导四向倍率；推导成功时倍率框是灰色只读「读数」，推不出来才是可编辑输入。
- **四向比例**：直接在画布示意图的上/右/下/左四个框里填倍率（1.0–2.0，1 表示不扩）。

填写提示：单边延伸建议控制在 **15% 以内**；超过 20% 更容易出现物体被复制或整张画面被重画。描述只写材质、光线、景深，不要列「右边加一个架子」这类物体清单；模型会把清单理解成「要新画的东西」。

生成后点候选图进大图，用中间的竖线对比：左边原图、右边生成后；拖滑块或按方向键都能移动。点 **只看结果** 切到单图。结果尺寸与画布一致时，点应用会扩展当前 PSD 并新建 `AI 图像工坊 扩图` 图层；尺寸对不上或文档在处理期间变化时，会把结果另开为文档，避免错位。

### 生成

1. 切到「生成」模式，写画面描述（此模式必填）。
2. 选输出尺寸、候选数量（1–4 张）；需要复现时填随机种子，留空为随机。
3. 点 **生成预览**，挑一张后应用。生成模式没有底稿，大图预览里只显示单张结果，面板会说明原因。

### 通用操作

- **候选与历史**：候选数量大于 1 会生成多张；每次生成是一批，预览区上方的「上一批 / 下一批」可来回翻看，不会重复付费。
- **费用确认**：CEP 在追加候选或重新生成前会弹确认；UXP 的「更多选项」里有「额外请求不再确认」复选框，勾上后不再逐次询问。
- **主题**：设置页底部有自动 / 深色 / PS 灰 / 浅色四种，自动跟随系统外观；PS 灰与 Photoshop 面板同色。
- **快捷入口**：CEP 可用 `dist/cep/studio-selection.jsx`（Photoshop **文件 > 脚本**），UXP 命令名为「按选区打开 AI 图像工坊」。它们只把选区带进面板，不会自动提交付费任务。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 面板显示「本地服务未启动」或启动超时 | 点状态条重试；看 `%LOCALAPPDATA%\Studio AI Image\service.log`。绿色包的安装目录里应同时有 `runtime/node.exe` 和 `service/src/main.js` |
| 「连接码无效」 | 服务在跑但码对不上。重启服务；CEP 可在 设置 > 本地服务 > 手填连接码，UXP 直接在设置页填 |
| 32145 端口被占用 | 关闭占用程序；进阶用户可设 `STUDIO_PORT`，但必须同时改面板写死的服务地址 |
| 测试连通通过但生成失败 | 连通测试不查余额、出图权限和模型可用性；换模型或确认账号额度 |
| 模型清单里没有要用的模型 | 选「自定义模型名…」手填，再点测试连通。Vertex Express 不提供模型列表，只能用内置预设 |
| 扩图区是空的或整张被重画 | 缩小单边比例、改成一次只扩一个方向，描述只写材质和光线；面板会自动换请求形态重试 |
| 安装时提示 Photoshop 正在运行 | 完全退出 Photoshop 再运行 `install.ps1` / `install.bat` |
| UXP 面板连不上服务 | UXP 不会自动拉起服务；先在 `service` 目录 `node src/main.js`，再填连接码 |

## 开发者说明

仓库根目录提供开发工作流命令（需要 Git、Node 20.9+）：

- `npm run sync`：把 `hosts/shared/` 的 5 个唯一源同步到 CEP/UXP 两端。
- `npm run verify`：同步检查 + 宿主测试 + 打包完整性验证。
- `npm test`：全量自动化测试（CEP/UXP 与 Service）。
- `npm run build`：构建绿色包，等价于 `release/build-bundle.ps1`。

也可以直接调用脚本：

```powershell
# 测试
node --test hosts/cep/test/*.test.js hosts/uxp/test/*.test.js
npm --prefix service test

# 同步唯一源（手动等价命令）
cp hosts/shared/panel.css hosts/cep/css/panel.css
cp hosts/shared/panel.css hosts/uxp/css/panel.css

# 构建三个包
powershell -File .\release\build-cep.ps1
powershell -File .\release\build-uxp.ps1
powershell -File .\release\build-service.ps1
powershell -File .\release\verify-packages.ps1
```

浏览器里调试 UI 不必开 Photoshop：打开 `preview/live.html` 看可交互面板，打开 `preview/ui-template.html` 看组件活文档。两者引用真实 CSS，跟随源码变化。

完整二次开发流程见 [docs/development-guide.md](docs/development-guide.md)；UI 强制规范见 [docs/ui-style-guide.md](docs/ui-style-guide.md)；给 AI 会话和协作者的硬约束见 [AGENTS.md](AGENTS.md)。

## 实现约定

这几条是跨端几何与 UI 的底线，改代码前先看：

- **`canvasBounds` 是几何真值**：扩图只用它算「原照片在画布里的位置」；alpha 反推只是备胎。活动图层可能是画面一角或透明带，不能当照片本体。
- **结果图必须是画布尺寸，且只有新增区有像素**：`apply` 依赖这个前提把结果贴成独立图层，原图层一个像素都不改。
- **扩图结果永远是独立图层**，不合并回原图层；可对比、可单独删、不会把智能对象光栅化。
- **面板视觉只有一处源**：`hosts/shared/panel.css`，CEP/UXP 两份副本逐字节一致（`panel-parity.test.js` 断言）。视觉方向是「暗房仪器」：石墨底 + 单一琥珀强调色，层次靠 1px 细线和灰阶差，数字等宽。
- **CEP 是 Chromium 61**：`flex` 的 `gap`、`:has`、`:is`、`clamp()`、`conic-gradient`、`aspect-ratio`、`inset:0` 都不能用——降级是静默的，界面只是「没生效」。
- **鉴权契约**：面板请求带 `X-STUDIO-Client: studio-plugin` 和 `X-STUDIO-Token: <连接码>`；Origin 白名单按 `plugin://` 前缀放行。

更多实测结论与踩坑记录见 [docs/development-guide.md](docs/development-guide.md) 第 7 节。

## 边界与参考

- 当前没有在真实 Photoshop 中逐版本跑通 CEP/UXP 全流程；[兼容性表](docs/compatibility-matrix.md)如实标记「未测试」。
- 大图局部编辑会裁出最多 4096 像素的工作区域；整图重绘和扩图的输入画布上限是 8192 像素，超出模型输出能力的部分会自动降采样再还原。
- 原生画布右键菜单没有接入；快捷入口位于脚本/插件命令菜单。
- 生成接口：[阿里云图像编辑 API](https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference)、[阿里云 Wan2.7 图像 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)。
- Photoshop 接口：[Adobe CEP](https://github.com/Adobe-CEP/CEP-Resources)、[Adobe UXP Imaging API](https://developer.adobe.com/photoshop/uxp/ps_reference/media/imaging/)。
