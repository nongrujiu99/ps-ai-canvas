# Photoshop 2018–2023 CEP 面板

此目录是可加载的 CEP 扩展源码。需同时启动 [`service`](../../service/README.md) 中的本地服务。CEP 目标为 Photoshop 19–24；当前尚未在真实 Photoshop 上验证。

开发加载：仓库根目录已有构建好的 [`dist/cep/org.psai.canvas`](../../dist/cep/org.psai.canvas)。PS 2018 运行 `powershell -ExecutionPolicy Bypass -File .\release\install-dev-cep.ps1 -CsxsVersion 8`；PS 2019–2020 将参数改为 `9`，PS 2021 改为 `10`，PS 2022–2023 改为 `11`。[Adobe CEP 官方表](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_11.x/Documentation/CEP%2011.1%20HTML%20Extension%20Cookbook.md)列有主要版本对应关系；2023 尚待实机核对。脚本把扩展复制到当前用户的 `%APPDATA%\Adobe\CEP\extensions\org.psai.canvas`，并在相应当前用户 CSXS 项设置 `PlayerDebugMode=1`。重启 Photoshop 后在“窗口 > 扩展 > PS AI 画布”打开面板。已有同名扩展时脚本会停止。正式分发需使用 Adobe 签名工具制作 ZXP；此仓库不包含签名证书。

快捷入口：[打包脚本](../../dist/cep/ps-ai-selection.jsx) 名为 `ps-ai-selection.jsx`。可从 Photoshop 的“文件 > 脚本 > 浏览”选择它；如需固定菜单项，再把它放到该 Photoshop 安装目录的 `Presets\Scripts` 并重启。该入口把当前选区交给已打开的面板识别，随后仍需在面板确认并生成，不会通过原生画布右键菜单插入命令。

首次使用先在面板“设置”里输入本地服务窗口显示的连接码，再配置北京地域百炼 API Key 与业务空间 ID。输入图像限 RGB 8 位；大图局部编辑会裁出 512–4096 像素的工作区域，整图重绘与扩图的原画布仍须符合该范围。生成预览会调用付费 API；应用结果前原 PSD 不会改变。整图重绘在“选区编辑 > 高级设置”，手工扩图可先扩大画布并框选规则透明边缘。四向扩图的输出尺寸与比例准确对应时才扩展当前 PSD，否则单独打开结果。

版本实测记录在 [`test/bridge-checklist.md`](test/bridge-checklist.md)。
