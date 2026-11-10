#target photoshop

(function () {
    if (!app.documents.length) { alert('请先打开文档并框选需要编辑或扩图的区域。'); return; }
    try {
        new ExternalObject('lib:PlugPlugExternalObject');
        var event = new CSXSEvent();
        event.type = 'org.psai.canvas.quick';
        event.scope = 'APPLICATION';
        event.dispatch();
        alert('已发送选区识别请求。请在“PS AI 画布”面板确认模式和描述，再点击“生成预览”；若面板未打开，请先在窗口菜单打开。');
    } catch (_) {
        alert('无法通知“PS AI 画布”面板。请先打开面板，再手动选择“选区编辑”或“扩图”。');
    }
}());
