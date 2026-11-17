'use strict';

require('./theme');   // 主题要在渲染前上色，所以放在最前
const photoshop = require('photoshop');
const uxp = require('uxp');
const { createHost } = require('./photoshop-host');
const { createClient } = require('./service-client');
const { createController } = require('./panel');
const { createChannelView, providerSummary } = require('./channel-view');
const { createCompareView } = require('./compare-view');

// UXP 的 CSS 是 Chromium 的一个子集，:focus-visible 不一定在。CEP 那边靠 main.js 探一次，
// 这里做同样的事，避免「新宿主上键盘走一圈看不见焦点」。.pointer 的用法与 CEP 完全一致：
// 鼠标点过就撤掉焦点线，敲键盘再放回来。
try {
  document.querySelector(':focus-visible');
} catch (e) {
  document.documentElement.classList.add('legacy-focus');
}
try {
  const root = document.documentElement;
  document.addEventListener('mousedown', () => root.classList.add('pointer'), true);
  document.addEventListener('keydown', () => root.classList.remove('pointer'), true);
} catch (e) {
  // 没有事件系统就不做这件事，焦点线退化成始终显示，不影响功能。
}

const host = createHost({ app: photoshop.app, imaging: photoshop.imaging, core: photoshop.core, action: photoshop.action, constants: photoshop.constants });
const service = createClient();
const $ = (id) => document.getElementById(id);
let quickPending = false;
const controller = createController({ host, service, notify: render, confirmCost: () => $('cost-confirm').checked });

function showError(error) { busySince = 0; $('status').textContent = error.message || '操作失败。'; $('status').className = 'status error'; }
function fmtScale(value) { return String(Math.round(Number(value) * 1000) / 1000); }
function previewSrc(item) { return typeof item === 'string' ? item : item.preview; }
// 预览卡片复用而不是每次重建：重建会让 <img> 重新解码 data URL，多候选时面板会闪。
// 数组里存 {el, img, use, badge} 这套引用，不依赖 children/lastChild 这类集合接口
// （UXP 上的支持面更小），也不往 DOM 节点上挂自定义属性。
const previewCards = [];
// 点开的大图对比层。原图来自服务端（提交时留的缩小版）：UXP 抓图给的是裸 RGBA，
// 前端没有 PNG 编码器，不能像 CEP 那样直接用 capture.image。
const compare = createCompareView({ $ });
compare.bind();
// 卡片是复用的，点击时要拿到「当前这一批」的原图和结果，所以留一份最新的 state。
let lastState = null;
// 缓存最近一次 host.inspect() 的结果，用于「无选区时禁用生成按钮」的判断
// （refreshDocument 每秒刷新）。与 CEP 保持同一套逻辑。
let lastCtx = null;
// 生成期间显示占位卡。之前预览区在等待时是整块空白，用户分不清「在跑」还是
// 「点了没反应」——状态栏那行小字在一个高面板里太容易被忽略。
let placeholder = null;
function ensurePlaceholder() {
  if (placeholder) return placeholder;
  const box = $('previews');
  placeholder = document.createElement('div');
  placeholder.className = 'preview-placeholder hidden';
  const ring = document.createElement('div'); ring.className = 'ph-ring';
  const label = document.createElement('div'); label.className = 'ph-label'; label.textContent = '生成中';
  const note = document.createElement('div'); note.className = 'ph-note'; note.textContent = '画布越大越慢，通常 30 秒到 3 分钟';
  placeholder.appendChild(ring); placeholder.appendChild(label); placeholder.appendChild(note);
  box.parentNode.insertBefore(placeholder, box);
  return placeholder;
}
let focusedCardIndex = 0;
function updateCardFocus(index) {
  if (previewCards.length === 0) return;
  focusedCardIndex = Math.max(0, Math.min(index, previewCards.length - 1));
  previewCards.forEach((card, i) => {
    if (card && card.el) card.el.classList.toggle('focused', i === focusedCardIndex);
  });
}
function renderHistoryBar(state) {
  const bar = $('history-bar');
  if (!bar) return;
  const showBar = state.status === 'preview' && (state.historyCount || 0) > 1;
  bar.classList.toggle('hidden', !showBar);
  if (!showBar) return;
  const cur = (state.historyIndex || 0) + 1;
  const total = state.historyCount || 1;
  $('history-label').textContent = `批次 ${cur} / ${total}`;
  $('history-prev').disabled = cur <= 1;
  $('history-next').disabled = cur >= total;
}
function renderPreviews(state) {
  lastState = state;
  const box = $('previews');
  const busy = ['submitting', 'running'].includes(state.status);
  ensurePlaceholder().classList.toggle('hidden', !busy);
  renderHistoryBar(state);
  if (state.status !== 'preview') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const items = state.previews;
  // 单张候选改成整宽（样式里按 data-count 切列数），否则图只占半边、还小得像缩略图。
  box.setAttribute('data-count', items.length);
  while (previewCards.length > items.length) box.removeChild(previewCards.pop().el);
  for (let i = 0; i < items.length; i++) {
    let card = previewCards[i];
    if (!card) {
      const el = document.createElement('div'); el.className = 'preview';
      const badge = document.createElement('span'); badge.className = 'idx';
      const img = document.createElement('img'); img.alt = '候选图 ' + (i + 1);
      // 图本身就是「看大图」的入口；右上角再放一个放大键，照顾「看不出图能点」的人。
      const zoom = document.createElement('button'); zoom.className = 'preview-zoom';
      zoom.setAttribute('aria-label', '打开对比预览');
      zoom.title = '打开对比预览';
      zoom.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg>';
      const use = document.createElement('button'); use.textContent = '应用';
      el.appendChild(badge); el.appendChild(img); el.appendChild(zoom); el.appendChild(use);
      box.appendChild(el);
      // 存引用对象，不往 DOM 节点上挂自定义属性：UXP 的节点是原生对象的包装。
      card = { el: el, img: img, zoom: zoom, use: use, badge: badge };
      previewCards[i] = card;
    }
    card.badge.textContent = (i < 9 ? '0' : '') + (i + 1);
    card.img.src = previewSrc(items[i]);
    // 复用卡片时用 onclick，避免 addEventListener 越叠越多。
    card.use.onclick = () => controller.accept(i).catch(showError);
    card.img.onclick = () => { updateCardFocus(i); openViewer(i); };
    card.zoom.onclick = () => { updateCardFocus(i); openViewer(i); };
  }
  updateCardFocus(0);
}
// 打开大图对比。原图只在这次任务带回了缩小版时才有（纯生成没有底稿），
// 没有就退化成单图预览——不要画一个拖了没反应的滑块。
function openViewer(index) {
  const state = lastState;
  if (!state || !state.previews || !state.previews[index]) return;
  compare.open({ after: previewSrc(state.previews[index]), before: state.origin, index, count: state.previews.length });
}
// 大图在同步出图的渠道上要跑两三分钟。只写「正在生成预览…」不给时间，
// 用户到一分钟就会以为卡死，然后关面板——任务其实还在跑。计时器让等待有进度感。
let busySince = 0;
let busyState = null;
function statusText(state) {
  let text = state.message || '';
  if (busySince) text += (text ? '  ·  ' : '') + Math.round((Date.now() - busySince) / 1000) + ' 秒';
  return text;
}
// 倍率框有两种身份，界面上必须分得开：推导成功时它们是「读数」（灰、只读），
// 否则才是「输入」。不加这一层，框里会永远停着一个手填的默认值，而实际用的是
// 透明边算出来的另一个数——用户看到「右 1.5」却得到 1.11 的扩张，只能理解成识别不对。
function updateScaleNote(derived) {
  const note = $('scale-note');
  if (!note) return;
  let count = 0;
  for (const id of ['top', 'right', 'bottom', 'left']) {
    const node = $(id);
    if (node && Number(node.value) > 1.001) count++;
  }
  let base = derived
    ? '四个数字由画布透明边推算，只显示、不能改。<br>描述只写材质和光线，别列物体。'
    : '倍率按画布透明边自动推算（1 = 不扩）。<br>描述只写材质和光线，别列物体。';
  if (count >= 2) {
    base += '<span class="scale-warn">提示：同时向多方向扩图易重新构图，建议单向分步扩展。</span>';
  }
  note.innerHTML = base;
}
function setScalesDerived(derived) {
  const grid = $('scale-grid');
  if (grid) grid.classList.toggle('derived', derived);
  ['top', 'right', 'bottom', 'left'].forEach((id) => { if ($(id)) $(id).readOnly = derived; });
  updateScaleNote(derived);
}
// 根据当前模式和最新画布上下文决定「生成预览」按钮的可用状态与文案。
// 选区编辑模式下没有选区时置灰并提示先框选；忙碌时按原逻辑 disabled，不改文案。
// 与 CEP 同一套判定，避免两端行为分叉。
function updateRunButton(busyOverride) {
  const runBtn = $('run');
  if (!runBtn) return;
  const mode = controller.state().mode;
  const busy = busyOverride !== undefined ? busyOverride
    : ['preparing', 'submitting', 'running'].includes(controller.state().status);
  const needsSelection = (mode === 'edit') && lastCtx && !lastCtx.selectionBounds && !busy;
  if (busy) {
    runBtn.disabled = true;
    // 文案在 render() 里管（重试 / 生成预览），这里不干扰
  } else if (needsSelection) {
    runBtn.disabled = true;
    runBtn.textContent = '请先框选区域';
  } else {
    runBtn.disabled = false;
    const label = controller.state().status === 'error' ? '重试' : '生成预览';
    if (runBtn.textContent !== label) runBtn.textContent = label;
  }
}
function render(state) {
  // 扩图比例可能由画布透明边自动推导：回填输入框，避免界面显示的值和实际用的值不一致。
  if (state.appliedScales) {
    $('top').value = fmtScale(state.appliedScales.top);
    $('right').value = fmtScale(state.appliedScales.right);
    $('bottom').value = fmtScale(state.appliedScales.bottom);
    $('left').value = fmtScale(state.appliedScales.left);
  }
  setScalesDerived(!!state.scalesDerived);
  const busy = ['preparing', 'submitting', 'running'].includes(state.status);
  if (busy && !busySince) busySince = Date.now();
  if (!busy) busySince = 0;
  busyState = state;
  $('status').textContent = statusText(state);
  $('status').className = 'status' + (state.status === 'error' ? ' error' : state.status === 'applied' ? ' ok' : '');
  // 失败后把按钮改成「重试」，无选区时置灰并提示——统一交给 updateRunButton。
  updateRunButton(busy);
  $('cancel').classList.toggle('hidden', state.status !== 'running');
  renderPreviews(state);
}
setInterval(() => { if (busySince && busyState) $('status').textContent = statusText(busyState); }, 1000);
// 「更多选项」没有可见项时整块收起来，不留一个点开是空的 ＋。
function hideEmptyAdvanced() {
  const rows = $('advanced').querySelectorAll('.advanced-fields > label');
  const anyShown = Array.prototype.some.call(rows, (row) => !row.classList.contains('hidden'));
  $('advanced').classList.toggle('hidden', !anyShown);
}
function modeChanged(mode) {
  controller.setMode(mode);
  // 换模式后上次的推导结果不再作数，否则切回来会看到上一张画布的读数。
  setScalesDerived(false);
  document.querySelectorAll('.mode').forEach((button) => button.classList.toggle('active', button.getAttribute('data-mode') === mode));
  $('expand-directions').classList.toggle('hidden', mode !== 'expand');
  $('whole-row').classList.toggle('hidden', mode !== 'edit');
  $('size-row').classList.toggle('hidden', mode !== 'generate');
  $('strength-row').classList.toggle('hidden', mode !== 'edit' || !$('whole').checked);
  // 三个短参数已提到常显的参数行，这层只剩条件项，没有可见项时整块收起来。
  hideEmptyAdvanced();
  $('prompt-hint').textContent = mode === 'generate' || (mode === 'edit' && $('whole').checked) ? '必填' : '可留空';
  $('prompt').placeholder = mode === 'expand'
    ? '扩图：只写延伸区域的材质与光线（如：海边日落余晖、深色木地板延续），避免列新物体'
    : mode === 'generate'
      ? '文生图：输入画面主体、构图与艺术风格（如：极简陶瓷花瓶，柔和摄影光）'
      : '选区编辑：留空自然补全，写描述局部重绘（如：把选区里的杯子换成白色花瓶）';
  // 切换模式后按选区状态重新评估按钮——用户很可能在没有选区时切到「选区编辑」。
  updateRunButton();
}
function values() {
  return { mode: controller.state().mode, prompt: $('prompt').value, whole: $('whole').checked, strength: $('strength').value, n: Number($('count').value), size: $('size').value, seed: $('seed').value,
    scales: { top: Number($('top').value), right: Number($('right').value), bottom: Number($('bottom').value), left: Number($('left').value) } };
}
// 副标只留「多大、有没有选区」；位深这类只在排查时用的信息收进 tooltip。
async function refreshDocument() {
  try {
    const ctx = await host.inspect();
    lastCtx = ctx;
    const text = `${ctx.width} × ${ctx.height} · ${ctx.selectionBounds ? '有选区' : '无选区'}`;
    $('document').textContent = text;
    $('document').title = `${text} · RGB 8 位`;
    updateRunButton();
  } catch (error) { $('document').textContent = error.message; }
}
async function quickRoute() {
  try {
    const ctx = await host.inspect();
    if (!ctx.selectionBounds) { $('status').textContent = '请先框选画面或新增的透明边缘。'; return; }
    const large = ctx.width > 4096 || ctx.height > 4096;
    const capture = await host.capture(large ? 'editMasked' : 'expand');
    const result = await service.inspect({ image: capture.image, mask: capture.mask });
    if (result.selectionKind === 'transparentBorder' && large) { $('status').textContent = '当前画布超过 4096 像素，暂不支持扩图。'; return; }
    if (result.selectionKind === 'transparentBorder') modeChanged('expand');
    else if (result.selectionKind === 'inside') modeChanged('edit');
    else { $('status').textContent = '选区不明确，请调整选区后再试。'; return; }
    $('status').textContent = '已按选区识别操作。确认描述后点击“生成预览”。';
  } catch (error) { showError(error); }
}

// 顶部渠道条：打开面板就能看到「连没连上 / 走哪个渠道 / 当前模型」。
// 这些信息原来只埋在设置页里，用户往往是点了生成、失败之后才发现 Key 没填。
// 文案判定在共享模块里（两端同一份），这里只管把结果画到 DOM 上。
// 一行拆两段：label 是固定类别，detail 是变化的那半截（模型名 / 下一步动作）。
// detail 由 CSS 画成胶囊并用 tone 上色，所以状态色只出现在这一处。
function paintProvider(label, detail, tone, title) {
  const button = $('provider');
  $('provider-label').textContent = label;
  $('provider-chip').textContent = detail || '';
  button.className = 'provider' + (tone ? ' ' + tone : '');
  button.title = title || (detail ? `${label} · ${detail}` : label) + '　点击查看或修改';
}

async function refreshProvider() {
  paintProvider('本地服务', '正在检查…', '');
  try {
    const info = providerSummary(await service.channel());
    paintProvider(info.label, info.detail, info.tone);
  } catch (error) {
    // 连不上和「连接码不对」要分开：前者要去开服务，后者只要重填码。
    const message = (error && error.message) || '';
    // UXP 沙箱不允许起进程，这里没法像 CEP 那样一键启动，文案不能暗示可以。
    if (/连接码无效/.test(message)) paintProvider('连接码无效', '点此重新填写', 'error', message);
    else paintProvider('本地服务未连接', '点此查看', 'error', message || '无法连接本地服务');
  }
}

document.querySelectorAll('.mode').forEach((button) => button.addEventListener('click', () => modeChanged(button.getAttribute('data-mode'))));
$('whole').addEventListener('change', () => modeChanged(controller.state().mode));
// 快捷键：Ctrl+Enter / Cmd+Enter 快速触发生成，符合专业修图师盲操肌肉记忆
$('prompt').addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (event.preventDefault) event.preventDefault();
    if (!$('run').disabled) $('run').click();
  }
});
// 手动调倍率时实时刷新双向预警
['top', 'right', 'bottom', 'left'].forEach((id) => {
  if ($(id)) $(id).addEventListener('input', () => updateScaleNote(false));
});
// 键盘快捷键体系（P2）：
// 1. 大图预览开启时：数字键 1~4 盲操切图
// 2. 主面板显示结果卡片时：数字键聚焦卡片、Enter 应用当前卡片、Space 打开对比、[ / ] 翻页历史批次
document.addEventListener('keydown', (event) => {
  // Enter / 空格 / 数字键在控件聚焦时属于控件自己。以前这里只挡了输入框，
  // Tab 到「取消」「生成」按钮再按 Enter，会被抢去执行「应用结果」把图贴回
  // 原图——不可逆误操作。按钮、链接、可编辑区一律放行给它们的原生行为。
  const active = document.activeElement;
  const activeTag = active ? active.tagName.toUpperCase() : '';
  const isControlFocused = !!active && (
    activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT'
    || activeTag === 'BUTTON' || activeTag === 'A' || activeTag === 'SUMMARY'
    || active.isContentEditable === true
    || (typeof active.getAttribute === 'function' && active.getAttribute('contenteditable') !== null)
  );
  if (!isControlFocused && compare.state().open && lastState && lastState.previews && lastState.previews.length > 1) {
    const n = parseInt(event.key, 10);
    if (n >= 1 && n <= lastState.previews.length) {
      openViewer(n - 1);
      if (event.preventDefault) event.preventDefault();
      return;
    }
  }
  if (!compare.state().open && !isControlFocused && lastState && lastState.status === 'preview' && previewCards.length > 0) {
    const num = parseInt(event.key, 10);
    if (num >= 1 && num <= previewCards.length) {
      updateCardFocus(num - 1);
      if (event.preventDefault) event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      if (previewCards[focusedCardIndex]) {
        previewCards[focusedCardIndex].use.click();
        if (event.preventDefault) event.preventDefault();
        return;
      }
    }
    if (event.key === ' ' || event.code === 'Space') {
      openViewer(focusedCardIndex);
      if (event.preventDefault) event.preventDefault();
      return;
    }
    if (event.key === '[') {
      controller.navHistory(-1);
      if (event.preventDefault) event.preventDefault();
      return;
    }
    if (event.key === ']') {
      controller.navHistory(1);
      if (event.preventDefault) event.preventDefault();
      return;
    }
  }
});
$('history-prev').addEventListener('click', () => controller.navHistory(-1));
$('history-next').addEventListener('click', () => controller.navHistory(1));
$('run').addEventListener('click', () => controller.run(values()).catch(showError));
$('cancel').addEventListener('click', () => controller.cancel().catch(showError));
// 渠道切换放在面板里：换中转站/换模型不用改 openai.env、不用重开终端。
const channelView = createChannelView({ $, service });
channelView.bind();
$('settings-toggle').addEventListener('click', () => {
  const hidden = $('settings').classList.toggle('hidden');
  // 每次打开设置页都重新拉一次：渠道可能在别处（改过配置文件）已经变了。
  if (!hidden) channelView.load();
});
$('settings-close').addEventListener('click', () => { $('settings').classList.add('hidden'); refreshProvider(); });
// 整条可点：状态是「未连接」「未填 Key」时，用户的第一反应就是去改，别让他找齿轮。
$('provider').addEventListener('click', () => {
  $('settings').classList.remove('hidden');
  channelView.load();
});
$('save-token').addEventListener('click', () => {
  try {
    service.setToken($('client-token').value);
    $('client-token').value = '';
    service.status().then(() => { $('settings-status').textContent = '本地服务已连接。'; channelView.load(); refreshProvider(); }, (error) => { $('settings-status').textContent = error.message; refreshProvider(); });
  } catch (error) { $('settings-status').textContent = error.message; }
});
service.status().then((status) => { $('settings-status').textContent = status.configured ? '已连接本地服务。' : '已连接，但还没有配置 API Key。'; }, () => { $('settings-status').textContent = '请先输入连接码连接本地服务。'; });
modeChanged('edit');
refreshDocument();
refreshProvider();

uxp.entrypoints.setup({
  panels: { canvas: { show() { refreshDocument(); if (quickPending) { quickPending = false; quickRoute(); } } } },
  commands: { quick() {
    quickPending = true;
    const self = Array.from(uxp.pluginManager.plugins).find((plugin) => plugin.id === 'org.studio.aiimg.uxp');
    if (self) self.showPanel('canvas').then(() => { if (quickPending) { quickPending = false; quickRoute(); } }).catch(showError);
    else quickRoute();
  } },
});
