AI 图像工坊 —— Photoshop 面板（绿色包）
========================================

这个文件夹里带了运行环境，目标电脑不需要装 Node.js，也不需要开命令行。


安装
----
1. 关闭 Photoshop。
2. 双击 install.bat。
3. 打开 Photoshop > 窗口 > 扩展 > AI 图像工坊。

装完就可以把这个文件夹删掉——面板、运行环境、本地服务都已经复制到
%APPDATA%\Adobe\CEP\extensions\org.studio.aiimg 了。


第一次使用
----------
1. 面板顶部那条状态会显示「本地服务未启动 · 点此启动」，点一下。
   本地服务会在后台起来，连接码自动读取，不用输入任何东西。
2. 点右上角齿轮 > 生成渠道，选择「百炼」或「第三方 API」，填服务地址、
   API Key、模型名，保存。
3. 回主界面，框选画面或留出透明边，点「生成预览」。

之后每次打开 Photoshop，服务没起来时点一下状态条即可；直接点「生成预览」
也会自动拉起。


关于 API Key
------------
Key 存在 Windows 凭据管理器里，按当前 Windows 用户加密。所以：

  - 拷给别人时，里面没有你的 Key，对方要填自己的。
  - 换电脑重装系统后，Key 需要重新填一次（凭据跟着用户走，不跟文件走）。

这一点是刻意的：如果把 Key 写进配置文件，任何拿到这个文件夹的人
都能用你的账户花钱。


要求
----
- Windows 10 / 11
- Photoshop CC 2018（19.0）或更高版本
- 首次使用需要联网（生成图片时要访问你配置的接口）


出问题时
--------
- 面板显示「连接码无效」：说明服务在跑但码对不上，通常是删过
  %LOCALAPPDATA%\Studio AI Image\client-token。重新启动一次服务即可。
- 面板显示「本地服务启动超时」：看
  %LOCALAPPDATA%\Studio AI Image\service.log。
- 想彻底重装：删掉 %APPDATA%\Adobe\CEP\extensions\org.studio.aiimg
  再双击 install.bat。
