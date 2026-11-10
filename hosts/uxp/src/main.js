'use strict';

const photoshop = require('photoshop');
const uxp = require('uxp');
const { createHost } = require('./photoshop-host');
const { createClient } = require('./service-client');
const { createController } = require('./panel');

const host = createHost({ app: photoshop.app, imaging: photoshop.imaging, core: photoshop.core, action: photoshop.action, constants: photoshop.constants });
const service = createClient();
const $ = (id) => document.getElementById(id);
let quickPending = false;
const controller = createController({ host, service, notify: render, confirmCost: () => $('cost-confirm').checked });

function showError(error) { $('status').textContent = error.message || '操作失败。'; }
function render(state) {
  $('status').textContent = state.message || '结果会先在这里预览，确认后再写入 Photoshop。';
  $('run').disabled = ['preparing', 'submitting', 'running'].includes(state.status);
  $('cancel').classList.toggle('hidden', state.status !== 'running');
  $('previews').innerHTML = '';
  $('previews').classList.toggle('hidden', state.status !== 'preview');
  if (state.status === 'preview') state.previews.forEach((item, index) => {
    const card = document.createElement('div'); card.className = 'preview';
    const img = document.createElement('img'); img.src = item.preview; img.alt = '候选图 ' + (index + 1);
    const button = document.createElement('button'); button.textContent = '应用候选 ' + (index + 1);
    button.addEventListener('click', () => controller.accept(index).catch(showError));
    card.appendChild(img); card.appendChild(button); $('previews').appendChild(card);
  });
}
function modeChanged(mode) {
  controller.setMode(mode);
  document.querySelectorAll('.mode').forEach((button) => button.classList.toggle('active', button.getAttribute('data-mode') === mode));
  $('expand-directions').classList.toggle('hidden', mode !== 'expand');
  $('whole-row').classList.toggle('hidden', mode !== 'edit');
  $('size-row').classList.toggle('hidden', mode !== 'generate');
  $('strength-row').classList.toggle('hidden', mode !== 'edit' || !$('whole').checked);
  $('prompt-hint').textContent = mode === 'generate' || (mode === 'edit' && $('whole').checked) ? '必填' : '可留空';
}
function values() {
  return { mode: controller.state().mode, prompt: $('prompt').value, whole: $('whole').checked, strength: $('strength').value, n: Number($('count').value), size: $('size').value, seed: $('seed').value,
    scales: { top: Number($('top').value), right: Number($('right').value), bottom: Number($('bottom').value), left: Number($('left').value) } };
}
async function refreshDocument() {
  try { const ctx = await host.inspect(); $('document').textContent = `${ctx.width} × ${ctx.height} px · RGB 8 位 · ${ctx.selectionBounds ? '已有选区' : '无选区'}`; }
  catch (error) { $('document').textContent = error.message; }
}
async function quickRoute() {
  try {
    const capture = await host.capture('expand');
    if (!capture.mask) { $('status').textContent = '请先框选画面或新增的透明边缘。'; return; }
    const result = await service.inspect({ image: capture.image, mask: capture.mask });
    if (result.selectionKind === 'transparentBorder') modeChanged('expand');
    else if (result.selectionKind === 'inside') modeChanged('edit');
    else { $('status').textContent = '选区不明确，请调整选区后再试。'; return; }
    $('status').textContent = '已按选区识别操作。确认描述后点击“生成预览”。';
  } catch (error) { showError(error); }
}

document.querySelectorAll('.mode').forEach((button) => button.addEventListener('click', () => modeChanged(button.getAttribute('data-mode'))));
$('whole').addEventListener('change', () => modeChanged(controller.state().mode));
$('run').addEventListener('click', () => controller.run(values()).catch(showError));
$('cancel').addEventListener('click', () => controller.cancel().catch(showError));
$('settings-toggle').addEventListener('click', () => $('settings').classList.toggle('hidden'));
$('settings-close').addEventListener('click', () => $('settings').classList.add('hidden'));
$('save-token').addEventListener('click', () => {
  try {
    service.setToken($('client-token').value);
    $('client-token').value = '';
    service.status().then(() => { $('settings-status').textContent = '本地服务已连接。'; }, (error) => { $('settings-status').textContent = error.message; });
  } catch (error) { $('settings-status').textContent = error.message; }
});
$('save-key').addEventListener('click', () => service.saveKey($('api-key').value, $('workspace-id').value).then(() => { $('api-key').value = ''; $('settings-status').textContent = '设置已保存。'; }, (error) => { $('settings-status').textContent = error.message; }));
service.status().then((status) => { $('settings-status').textContent = status.configured ? `已配置业务空间 ${status.workspaceId}` : '尚未配置百炼。'; if (status.workspaceId) $('workspace-id').value = status.workspaceId; }, () => { $('settings-status').textContent = '请启动本地服务并输入连接码。'; });
modeChanged('edit');
refreshDocument();

uxp.entrypoints.setup({
  panels: { canvas: { show() { refreshDocument(); if (quickPending) { quickPending = false; quickRoute(); } } } },
  commands: { quick() {
    quickPending = true;
    const self = Array.from(uxp.pluginManager.plugins).find((plugin) => plugin.id === 'org.psai.canvas.uxp');
    if (self) self.showPanel('canvas').then(() => { if (quickPending) { quickPending = false; quickRoute(); } }).catch(showError);
    else quickRoute();
  } },
});
