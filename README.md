# PS AI 画布

面向 Windows 的 Photoshop AI 选区编辑、扩图与生成原型。旧版 Photoshop 2018–2023 使用 CEP，Photoshop 2024 起使用 UXP；两端共用本地 Node.js 服务和阿里云百炼适配器。编辑模型为 `wanx2.1-imageedit`，文生图模型为 `wan2.7-image`。

## 已实现

- 选区编辑：空描述自然补全，有描述时按指令局部重绘；整图重绘放在高级设置。
- 扩图：四向比例，或先手工扩大画布并框选规则透明边缘后自动识别；输出尺寸准确时扩展当前 PSD 并以新图层显示新增边缘。
- 文生图：输入描述，默认一张；最多四张候选，预览后才应用。
- 本地服务：校验图像、提交异步任务、轮询、下载并转为 PNG；API Key 存入 Windows 凭据管理器。
- 旧版脚本与新版命令提供快捷入口。快捷入口负责按选区分流到面板，仍需用户在面板确认并生成。

## 开发版使用方法

本仓库已生成三个开发加载包；插件在 Photoshop 菜单和面板中统一显示为 **PS AI 画布**。需要 Windows、Node.js 20.9 或更新版本，以及北京地域百炼 API Key 和业务空间 ID。

1. 在 PowerShell 进入 [`dist/service`](dist/service)，运行 `node .\src\main.js`。保持窗口打开，记下它显示的“Local connection code”。预打包服务带有当前 Windows 环境的依赖；换机器或架构时先在此目录运行 `npm ci`。
2. 在**另一个 PowerShell 窗口**进入本仓库根目录，按 Photoshop 版本加载面板：
   - **2018（19.x）**：运行 `powershell -ExecutionPolicy Bypass -File .\release\install-dev-cep.ps1 -CsxsVersion 8`。
   - **2019–2020（20–21.x）**：同一命令改用 `-CsxsVersion 9`。
   - **2021（22.x）**：同一命令改用 `-CsxsVersion 10`；**2022–2023（23–24.x）**：改用 `-CsxsVersion 11`。这几版尚未实机验证。
   - **2024 及更新（25.x+）**：安装 UXP Developer Tool 并启用开发者模式，在工具中选择 **Add Plugin**，打开 [`dist/uxp/org.psai.canvas.uxp/manifest.json`](dist/uxp/org.psai.canvas.uxp/manifest.json)，点击 **Load**；在 Photoshop 的 **插件** 菜单打开 **PS AI 画布**。[UXP 加载细节](hosts/uxp/README.md)。

   对使用 CEP 的版本，安装后重启 Photoshop，选择 **窗口 > 扩展 > PS AI 画布**。[CEP 安装细节](hosts/cep/README.md)。

3. 点击面板右上角设置，输入本地连接码并点击“连接本地服务”；再填写百炼业务空间 ID、API Key，点击“保存百炼设置”。连接码只供本机插件使用；不要把 API Key 写入源码或 PSD。
4. 打开 RGB 8 位文档，框选区域，选“选区编辑”并点击“生成预览”。不写描述会自然补全；写描述会局部重绘。查看候选后点“应用候选”。扩图可选择四向比例，或先手工扩大画布并框选新增透明边缘；文生图则选“生成”。

旧版可选快捷脚本为 [`dist/cep/ps-ai-selection.jsx`](dist/cep/ps-ai-selection.jsx)，在 Photoshop **文件 > 脚本** 运行；新版命令名为“按选区打开 PS AI 画布”。两者只把当前选区带入面板，不会自动提交付费请求。

三个包可通过 `release/build-cep.ps1`、`release/build-uxp.ps1`、`release/build-service.ps1` 重建，再运行 `release/verify-packages.ps1` 检查。服务自动测试：在 `service` 目录运行 `npm test`；面板逻辑测试：在仓库根目录运行 `node --test hosts/cep/test/*.test.js hosts/uxp/test/*.test.js`。

## 现阶段边界

当前机器没有 Photoshop，也没有百炼 API Key。CEP/UXP 在真实 Photoshop 的加载、羽化蒙版和回填位置未验证；[兼容性表](docs/compatibility-matrix.md)如实标记。大图的局部编辑会裁出最多 4096 像素的工作区域；整图重绘和扩图的输入画布仍需在 512–4096 像素范围内。四向滑杆扩图只有在输出尺寸与请求比例精确一致时才扩展原 PSD，尺寸不匹配则另开文档。手工扩画布的结果也只有在输出尺寸与画布一致时才作为新图层应用。原生画布右键菜单没有接入；快捷入口位于脚本/插件命令菜单。

模型接口依据：[阿里云图像编辑 API](https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference)、[阿里云 Wan2.7 图像 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)。Photoshop 接口依据：[Adobe CEP](https://github.com/Adobe-CEP/CEP-Resources)、[Adobe UXP Imaging API](https://developer.adobe.com/photoshop/uxp/ps_reference/media/imaging/)。
