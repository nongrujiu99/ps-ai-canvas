# Photoshop 2018–2023 CEP 面板

此目录是可加载的 CEP 扩展源码。需同时启动 [`service`](../../service/README.md) 中的本地服务。CEP 目标为 Photoshop 19–24；当前尚未在真实 Photoshop 上验证。

开发加载：先运行 `release/build-cep.ps1`，再运行 `release/install-dev-cep.ps1 -CsxsVersion 8`（PS 2018；PS 2019–2020 可选 9）。脚本把扩展复制到当前用户的 `%APPDATA%\Adobe\CEP\extensions\org.psai.canvas`，并在相应当前用户 CSXS 项设置 `PlayerDebugMode=1`。重启 Photoshop 后在“窗口 > 扩展”中打开“PS AI 画布”。已有同名扩展时脚本会停止，需手工决定如何处理旧目录。正式分发需使用 Adobe 签名工具制作 ZXP；此仓库不包含签名证书。

快捷入口：把 `jsx/quick-expand.jsx` 放到 Photoshop 的 Scripts 目录，重启后从“文件 > 脚本”运行；若版本支持，可在键盘快捷键设置中为脚本分配快捷键。该入口把当前选区交给已打开的面板识别，随后仍需在面板确认并生成，不会通过原生画布右键菜单插入命令。

首次使用在面板“设置”里配置北京地域百炼 API Key 与业务空间 ID。输入图像限 RGB 8 位，编辑图边长 512–4096 像素。生成预览会调用付费 API；应用结果前原 PSD 不会改变。整图重绘在“选区编辑 > 高级设置”，手工扩图可先扩大画布并框选规则透明边缘。

版本实测记录在 [`test/bridge-checklist.md`](test/bridge-checklist.md)。
