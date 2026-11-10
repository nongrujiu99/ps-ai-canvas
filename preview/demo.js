(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var mode = 'edit';
  var mockImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#314e79"/><stop offset="1" stop-color="#d5b9a6"/></linearGradient></defs><rect width="640" height="640" fill="url(#sky)"/><circle cx="446" cy="190" r="68" fill="#fff0ce"/><path d="M0 380 Q160 330 330 395 T640 360 V640 H0" fill="#658891"/><path d="M0 460 Q200 404 400 462 T640 428 V640 H0" fill="#315467"/><path d="M0 557 Q175 514 340 557 T640 522 V640 H0" fill="#183648"/></svg>');
  $('document').textContent = '1920 × 1280 px · RGB 8 位 · 已有选区';
  function setMode(next) {
    mode = next;
    var modes = document.querySelectorAll('.mode');
    for (var i = 0; i < modes.length; i++) modes[i].classList.toggle('active', modes[i].getAttribute('data-mode') === next);
    $('expand-directions').classList.toggle('hidden', next !== 'expand');
    $('whole-row').classList.toggle('hidden', next !== 'edit');
    $('size-row').classList.toggle('hidden', next !== 'generate');
    $('strength-row').classList.toggle('hidden', next !== 'edit' || !$('whole').checked);
    $('prompt-hint').textContent = next === 'generate' || (next === 'edit' && $('whole').checked) ? '必填' : '可留空';
    $('previews').classList.add('hidden');
    $('previews').innerHTML = '';
    $('status').textContent = next === 'expand' ? '可先扩大画布并框选新增的透明边缘。' : '结果会先在这里预览，确认后再写入 Photoshop。';
  }
  var modes = document.querySelectorAll('.mode');
  for (var i = 0; i < modes.length; i++) modes[i].addEventListener('click', function () { setMode(this.getAttribute('data-mode')); });
  $('whole').addEventListener('change', function () { setMode(mode); });
  $('settings-toggle').addEventListener('click', function () { $('settings').classList.toggle('hidden'); });
  $('save-key').addEventListener('click', function () { $('settings-status').textContent = '演示页面不会保存或发送密钥。'; $('api-key').value = ''; });
  $('run').addEventListener('click', function () {
    var prompt = $('prompt').value.trim();
    if ((mode === 'generate' || mode === 'edit' && $('whole').checked) && !prompt) { $('status').textContent = '请先输入画面描述。'; return; }
    $('run').disabled = true; $('status').textContent = '正在生成预览…（演示）';
    setTimeout(function () {
      $('run').disabled = false;
      $('previews').innerHTML = '';
      var count = Number($('count').value);
      for (var j = 0; j < count; j++) {
        var card = document.createElement('div'); card.className = 'preview';
        var img = document.createElement('img'); img.src = mockImage; img.alt = '演示候选图';
        var button = document.createElement('button'); button.textContent = '应用候选 ' + (j + 1);
        button.addEventListener('click', function () { $('status').textContent = '演示：真实插件会在此时新建图层或文档。'; });
        card.appendChild(img); card.appendChild(button); $('previews').appendChild(card);
      }
      $('previews').classList.remove('hidden');
      $('status').textContent = '选择满意的结果后应用。演示图片为占位图。';
    }, 550);
  });
  $('cancel').classList.add('hidden');
  setMode('edit');
}());
