(function () {
  'use strict';
  var cs = new CSInterface();
  var host = PSAIHost.createHost({ cs: cs, fs: window.cep.fs, encoding: window.cep.encoding });
  var service = PSAIService.createClient();
  var $ = function (id) { return document.getElementById(id); };
  var controller = PSAIPanel.createController({ host: host, service: service, notify: render, confirmCost: function () { return window.confirm('更多候选或重新生成会发起新的百炼请求，可能产生费用。继续吗？'); } });

  function render(state) {
    $('status').textContent = state.message || '结果会先在这里预览，确认后再写入 Photoshop。';
    $('run').disabled = ['preparing', 'submitting', 'running'].indexOf(state.status) >= 0;
    $('cancel').classList.toggle('hidden', state.status !== 'running');
    $('previews').innerHTML = '';
    $('previews').classList.toggle('hidden', state.status !== 'preview');
    if (state.status === 'preview') state.previews.forEach(function (src, index) {
      var card = document.createElement('div'); card.className = 'preview';
      var img = document.createElement('img'); img.src = src; img.alt = '候选图 ' + (index + 1);
      var button = document.createElement('button'); button.textContent = '应用候选 ' + (index + 1);
      button.addEventListener('click', function () { controller.accept(index).catch(showError); });
      card.appendChild(img); card.appendChild(button); $('previews').appendChild(card);
    });
  }
  function showError(error) { $('status').textContent = error.message || '操作失败。'; }
  function modeChanged(mode) {
    controller.setMode(mode);
    var buttons = document.querySelectorAll('.mode');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('active', buttons[i].getAttribute('data-mode') === mode);
    $('expand-directions').classList.toggle('hidden', mode !== 'expand');
    $('whole-row').classList.toggle('hidden', mode !== 'edit');
    $('size-row').classList.toggle('hidden', mode !== 'generate');
    $('strength-row').classList.toggle('hidden', mode !== 'edit' || !$('whole').checked);
    $('prompt-hint').textContent = mode === 'generate' || (mode === 'edit' && $('whole').checked) ? '必填' : '可留空';
    $('prompt').placeholder = mode === 'expand' ? '例如：向右延伸海边的日落天空（可留空）' : mode === 'generate' ? '例如：极简风格的陶瓷花瓶，柔和自然光' : '例如：把选区里的杯子换成白色陶瓷花瓶';
  }
  function values() {
    return {
      mode: controller.state().mode, prompt: $('prompt').value, whole: $('whole').checked,
      strength: $('strength').value, n: Number($('count').value), size: $('size').value, seed: $('seed').value,
      scales: { top: Number($('top').value), right: Number($('right').value), bottom: Number($('bottom').value), left: Number($('left').value) }
    };
  }
  function refreshDocument() {
    host.inspect().then(function (ctx) { $('document').textContent = ctx.width + ' × ' + ctx.height + ' px  ·  RGB 8 位' + (ctx.selectionBounds ? '  ·  已有选区' : '  ·  无选区'); }, function (error) { $('document').textContent = error.message; });
  }
  function quickRoute() {
    host.inspect().then(function (ctx) {
      if (!ctx.selectionBounds) { $('status').textContent = '请先框选画面或新增的透明边缘。'; return; }
      var large = ctx.width > 4096 || ctx.height > 4096;
      host.capture(large ? 'editMasked' : 'expand', {}).then(function (capture) {
        service.inspect({ image: capture.image, mask: capture.mask }).then(function (result) {
          host.dispose(capture);
          if (result.selectionKind === 'transparentBorder' && large) { $('status').textContent = '当前画布超过 4096 像素，暂不支持扩图。'; return; }
          if (result.selectionKind === 'transparentBorder') modeChanged('expand');
          else if (result.selectionKind === 'inside') modeChanged('edit');
          else { $('status').textContent = '选区不明确，请调整选区后再试。'; return; }
          $('status').textContent = '已按选区识别操作。确认描述后点击“生成预览”。';
        }, function (error) { host.dispose(capture); showError(error); });
      }, showError);
    }, showError);
  }

  var buttons = document.querySelectorAll('.mode');
  for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', function () { modeChanged(this.getAttribute('data-mode')); });
  $('whole').addEventListener('change', function () { modeChanged(controller.state().mode); });
  $('run').addEventListener('click', function () { controller.run(values()).catch(showError); });
  $('cancel').addEventListener('click', function () { controller.cancel().catch(showError); });
  $('settings-toggle').addEventListener('click', function () { $('settings').classList.toggle('hidden'); });
  $('settings-close').addEventListener('click', function () { $('settings').classList.add('hidden'); });
  $('save-token').addEventListener('click', function () {
    try {
      service.setToken($('client-token').value);
      $('client-token').value = '';
      service.status().then(function () { $('settings-status').textContent = '本地服务已连接。'; }, function (error) { $('settings-status').textContent = error.message; });
    } catch (error) { $('settings-status').textContent = error.message; }
  });
  $('save-key').addEventListener('click', function () {
    service.saveKey($('api-key').value, $('workspace-id').value).then(function () { $('api-key').value = ''; $('settings-status').textContent = '设置已保存。'; }, function (error) { $('settings-status').textContent = error.message; });
  });
  service.status().then(function (status) { $('settings-status').textContent = status.configured ? '已配置业务空间 ' + status.workspaceId : '尚未配置百炼。'; if (status.workspaceId) $('workspace-id').value = status.workspaceId; }, function () { $('settings-status').textContent = '请启动本地服务并输入连接码。'; });
  cs.addEventListener('org.psai.canvas.quick', quickRoute);
  window.addEventListener('unload', function () { controller.dispose(); });
  modeChanged('edit');
  refreshDocument();
}());
