# Photoshop 2024+ UXP 面板

此目录是 Photoshop 25.0 起的 UXP 可加载插件目录。先在 UXP Developer Tool 和 Photoshop 启用开发者模式，保持 Photoshop 运行；然后用 **Add Plugin** 选择构建包中的 [`manifest.json`](../../dist/uxp/org.psai.canvas.uxp/manifest.json)，点击 **Load**，在 Photoshop 插件菜单打开“PS AI 画布”。[Adobe 的加载步骤](https://developer.adobe.com/uxp/guides/how-to/udt-deep-dive/plugin-management)可供对照。需要同时运行 [`service`](../../service/README.md) 本地服务。当前没有真实 Photoshop 测试，因此 25.0 及后续版本均标为未验证。

“按选区打开 PS AI 画布”命令会打开面板并检查当前选区；在面板确认后才发起可能计费的生成请求。能否直接绑定 Photoshop 快捷键需在目标版本实测。原生画布右键菜单没有自定义入口。

首次使用先在面板“设置”里输入本地服务窗口显示的连接码，再配置百炼。首版只支持 RGB 8 位；大图局部编辑会裁出 512–4096 像素的工作区域，整图重绘和扩图的原画布仍须符合该范围。结果先在面板预览；应用时创建新像素图层，选区灰度用作图层蒙版。四向扩图的输出尺寸与比例准确对应时才扩展当前 PSD；尺寸不符或文档在等待期间变化时单独打开结果。UI 和真实图层位置仍需按版本检查。
