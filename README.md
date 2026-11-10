# PS AI 画布插件

面向 Windows 的 Photoshop AI 选区编辑、扩图与生成原型。旧版 Photoshop 2018–2023 使用 CEP，Photoshop 2024 起使用 UXP；两端共用本地 Node.js 服务和阿里云百炼适配器。编辑模型为 `wanx2.1-imageedit`，文生图模型为 `wan2.7-image`。

## 已实现

- 选区编辑：空描述自然补全，有描述时按指令局部重绘；整图重绘放在高级设置。
- 扩图：四向比例，或先手工扩大画布并框选规则透明边缘后自动识别；输出尺寸准确时扩展当前 PSD 并以新图层显示新增边缘。
- 文生图：输入描述，默认一张；最多四张候选，预览后才应用。
- 本地服务：校验图像、提交异步任务、轮询、下载并转为 PNG；API Key 存入 Windows 凭据管理器。
- 旧版脚本与新版命令提供快捷入口。快捷入口负责按选区分流到面板，仍需用户在面板确认并生成。

## 构建和试用

1. 安装 Node.js 20.9 或更新版本。在源码的 `service` 目录运行 `npm ci`，再运行 `npm start`。预打包的 [`dist/service`](dist/service) 已含当前 Windows 环境的依赖，可直接在该目录运行 `node src/main.js`。
2. 旧版 Photoshop：在 PowerShell 运行 `release/build-cep.ps1`，把 [`dist/cep/org.psai.canvas`](dist/cep/org.psai.canvas) 作为 CEP 扩展开发加载。详细步骤见 [CEP 说明](hosts/cep/README.md)。
3. 新版 Photoshop：运行 `release/build-uxp.ps1`，在 UXP Developer Tool 加载 [`dist/uxp/org.psai.canvas.uxp/manifest.json`](dist/uxp/org.psai.canvas.uxp/manifest.json)。详细步骤见 [UXP 说明](hosts/uxp/README.md)。
4. 启动服务后，复制窗口显示的本地连接码，在面板“设置”中先连接本地服务，再填入北京地域百炼 API Key 和业务空间 ID。连接码只供本机插件使用，不要公开；不要把 Key 写入源码或 PSD。

三个包可通过 `release/build-cep.ps1`、`release/build-uxp.ps1`、`release/build-service.ps1` 重建，再运行 `release/verify-packages.ps1` 检查。服务自动测试：在 `service` 目录运行 `npm test`；面板逻辑测试：在仓库根目录运行 `node --test hosts/cep/test/*.test.js hosts/uxp/test/*.test.js`。

## 现阶段边界

当前机器没有 Photoshop，也没有百炼 API Key。CEP/UXP 在真实 Photoshop 的加载、羽化蒙版和回填位置未验证；[兼容性表](docs/compatibility-matrix.md)如实标记。大图的局部编辑会裁出最多 4096 像素的工作区域；整图重绘和扩图的输入画布仍需在 512–4096 像素范围内。四向滑杆扩图只有在输出尺寸与请求比例精确一致时才扩展原 PSD，尺寸不匹配则另开文档。手工扩画布的结果也只有在输出尺寸与画布一致时才作为新图层应用。原生画布右键菜单没有接入；快捷入口位于脚本/插件命令菜单。

模型接口依据：[阿里云图像编辑 API](https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference)、[阿里云 Wan2.7 图像 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)。Photoshop 接口依据：[Adobe CEP](https://github.com/Adobe-CEP/CEP-Resources)、[Adobe UXP Imaging API](https://developer.adobe.com/photoshop/uxp/ps_reference/media/imaging/)。
