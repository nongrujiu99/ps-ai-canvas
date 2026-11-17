(function () {
  'use strict';
  // PS 2021 之前的 CEP 是 Chromium 61，没有 :focus-visible，panel.css 里那条规则会被整条丢弃。
  // 这里探一下：不支持就退回 :focus，否则键盘 Tab 走一圈完全看不出焦点在哪。
  try { document.querySelector(':focus-visible'); } catch (e) { document.documentElement.className += ' legacy-focus'; }
  // 退回 :focus 的代价是「鼠标点完焦点不走」，控件上会一直留一圈框——点一下模式按钮，
  // 那圈框和选中项的琥珀指示条并排出现，看着像两层黄边。这里记住最后一次输入是鼠标还是
  // 键盘：鼠标按下加 .pointer（CSS 撤掉焦点线），一敲键盘就摘掉。鼠标用户看不到多余的框，
  // 键盘用户照样知道自己停在哪。新版本 CEP 有 :focus-visible，这套不会生效，也不需要。
  (function trackInputDevice() {
    var root = document.documentElement;
    if (!root.classList || !document.addEventListener) return;
    document.addEventListener('mousedown', function () { root.classList.add('pointer'); }, true);
    document.addEventListener('keydown', function () { root.classList.remove('pointer'); }, true);
  }());
  var cs = new CSInterface();
  var host = StudioHost.createHost({ cs: cs, fs: window.cep.fs, encoding: window.cep.encoding });
  var service = StudioService.createClient();
  // 换电脑时最容易卡住的不是配 Key，而是「开终端 → 启动服务 → 复制 43 位连接码」。
  // 连接码本来就是服务写在本机文件里的，面板有读权限，直接读即可；服务没跑就自己拉起来。
  // 服务端的校验逻辑一行没改——浏览器网页仍然打不通，少掉的只是手工粘贴。
  var extRoot = '';
  try { extRoot = cs.getSystemPath(SystemPath.EXTENSION) || ''; } catch (e) {}
  var launcher = (typeof StudioLocalService === 'object' && StudioLocalService)
    ? StudioLocalService.createLauncher({ extRoot: extRoot })
    : { readToken: function () { return null; }, canLaunch: function () { return false; }, ensure: function () { var error = new Error('启动器未加载，请重新安装扩展。'); error.code = 'NO_LAUNCHER'; return Promise.reject(error); } };
  var $ = function (id) { return document.getElementById(id); };
  var controller = StudioPanel.createController({ host: host, service: service, notify: render, confirmCost: function () { return window.confirm('更多候选或重新生成会发起新的百炼请求，可能产生费用。继续吗？'); } });

  function fmtScale(value) {
    var n = Math.round(Number(value) * 1000) / 1000;
    return String(n);
  }
  function previewSrc(item) { return typeof item === 'string' ? item : item.preview; }
  // 预览卡片复用而不是每次 innerHTML='' 重建：重建会让 <img> 重新解码 data URL，
  // 多候选时面板会闪一下，大图尤其明显。
  // 存的是 {el, img, use, badge} 这套引用，而不是往 DOM 元素上挂自定义属性——
  // UXP 的节点是原生对象的包装，挂 expando 在不同版本上行为不一致。
  var previewCards = [];
  // 点开的大图对比层。原图来自服务端（提交时留的缩小版），不拿 capture.image：
  // UXP 那边的 capture 是裸 RGBA，前端没法直接当 <img> 用，两端各写一套必然分叉。
  var compare = StudioCompareView.createCompareView({ $: $ });
  compare.bind();
  // 卡片是复用的，点击时要拿到「当前这一批」的原图和结果，所以留一份最新的 state。
  var lastState = null;
  // 缓存最近一次 host.inspect() 的结果，用于按钮状态判断（refreshDocument 每秒刷新）。
  var lastCtx = null;
  // 生成期间显示占位卡。之前预览区在等待时是整块空白，用户分不清「在跑」还是
  // 「点了没反应」——状态栏那行小字在一个高面板里太容易被忽略。
  var placeholder = null;
  function ensurePlaceholder() {
    if (placeholder) return placeholder;
    var box = $('previews');
    placeholder = document.createElement('div');
    placeholder.className = 'preview-placeholder hidden';
    var ring = document.createElement('div'); ring.className = 'ph-ring';
    var label = document.createElement('div'); label.className = 'ph-label'; label.textContent = '生成中';
    var note = document.createElement('div'); note.className = 'ph-note'; note.textContent = '画布越大越慢，通常 30 秒到 3 分钟';
    placeholder.appendChild(ring); placeholder.appendChild(label); placeholder.appendChild(note);
    box.parentNode.insertBefore(placeholder, box);
    return placeholder;
  }
  var focusedCardIndex = 0;
  function updateCardFocus(index) {
    if (previewCards.length === 0) return;
    focusedCardIndex = Math.max(0, Math.min(index, previewCards.length - 1));
    for (var i = 0; i < previewCards.length; i++) {
      if (previewCards[i] && previewCards[i].el) {
        previewCards[i].el.classList.toggle('focused', i === focusedCardIndex);
      }
    }
  }
  function renderHistoryBar(state) {
    var bar = $('history-bar');
    if (!bar) return;
    var showBar = state.status === 'preview' && (state.historyCount || 0) > 1;
    bar.classList.toggle('hidden', !showBar);
    if (!showBar) return;
    var cur = (state.historyIndex || 0) + 1;
    var total = state.historyCount || 1;
    $('history-label').textContent = '批次 ' + cur + ' / ' + total;
    $('history-prev').disabled = cur <= 1;
    $('history-next').disabled = cur >= total;
  }
  function renderPreviews(state) {
    lastState = state;
    var box = $('previews');
    var busy = ['submitting', 'running'].indexOf(state.status) >= 0;
    ensurePlaceholder().classList.toggle('hidden', !busy);
    renderHistoryBar(state);
    if (state.status !== 'preview') { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var items = state.previews;
    // 单张候选改成整宽（样式里按 data-count 切列数），否则图只占半边、还小得像缩略图。
    box.setAttribute('data-count', items.length);
    while (previewCards.length > items.length) box.removeChild(previewCards.pop().el);
    for (var i = 0; i < items.length; i++) {
      var card = previewCards[i];
      if (!card) {
        var el = document.createElement('div'); el.className = 'preview';
        var badge = document.createElement('span'); badge.className = 'idx';
        var img = document.createElement('img'); img.alt = '候选图 ' + (i + 1);
        // 图本身就是「看大图」的入口；右上角再放一个放大键，照顾「看不出图能点」的人。
        var zoom = document.createElement('button'); zoom.className = 'preview-zoom';
        zoom.setAttribute('aria-label', '打开对比预览');
        zoom.title = '打开对比预览';
        zoom.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg>';
        var use = document.createElement('button'); use.textContent = '应用';
        el.appendChild(badge); el.appendChild(img); el.appendChild(zoom); el.appendChild(use);
        box.appendChild(el);
        card = { el: el, img: img, zoom: zoom, use: use, badge: badge };
        previewCards[i] = card;
      }
      card.badge.textContent = (i < 9 ? '0' : '') + (i + 1);
      card.img.src = previewSrc(items[i]);
      // 用 onclick 而不是 addEventListener：卡片是复用的，addEventListener 会越叠越多。
      card.use.onclick = (function (index) { return function () { controller.accept(index).catch(showError); }; }(i));
      card.img.onclick = (function (index) { return function () { updateCardFocus(index); openViewer(index); }; }(i));
      card.zoom.onclick = (function (index) { return function () { updateCardFocus(index); openViewer(index); }; }(i));
    }
    updateCardFocus(0);
  }
  // 打开大图对比。原图只在这次任务带回了缩小版时才有（纯生成没有底稿），
  // 没有就退化成单图预览——不要画一个拖了没反应的滑块。
  function openViewer(index) {
    var state = lastState;
    if (!state || !state.previews || !state.previews[index]) return;
    compare.open({ after: previewSrc(state.previews[index]), before: state.origin, index: index, count: state.previews.length });
  }
  // 大图在同步出图的渠道上要跑两三分钟。只写「正在生成预览…」不给时间，
  // 用户到一分钟就会以为卡死，然后关面板——任务其实还在跑。计时器让等待有进度感。
  var busySince = 0;
  var busyState = null;
  function statusText(state) {
    var text = state.message || '';
    if (busySince) {
      var seconds = Math.round((Date.now() - busySince) / 1000);
      text += (text ? '  ·  ' : '') + seconds + ' 秒';
    }
    return text;
  }
  // 倍率框有两种身份，界面上必须分得开：推导成功时它们是「读数」（灰、只读），
  // 否则才是「输入」。不加这一层，框里会永远停着一个手填的默认值，而服务端实际
  // 用的是透明边算出来的另一个数——用户看到「右 1.5」却得到了 1.11 的扩张，
  // 只能理解成「识别不对」。
  function updateScaleNote(derived) {
    var note = $('scale-note');
    if (!note) return;
    var count = 0;
    var ids = ['top', 'right', 'bottom', 'left'];
    for (var i = 0; i < ids.length; i++) {
      var node = $(ids[i]);
      if (node && Number(node.value) > 1.001) count++;
    }
    var base = derived
      ? '四个数字由画布透明边推算，只显示、不能改。<br>描述只写材质和光线，别列物体。'
      : '倍率按画布透明边自动推算（1 = 不扩）。<br>描述只写材质和光线，别列物体。';
    if (count >= 2) {
      base += '<span class="scale-warn">提示：同时向多方向扩图易重新构图，建议单向分步扩展。</span>';
    }
    note.innerHTML = base;
  }
  function setScalesDerived(derived) {
    var grid = $('scale-grid');
    if (grid) grid.classList.toggle('derived', derived);
    var ids = ['top', 'right', 'bottom', 'left'];
    for (var i = 0; i < ids.length; i++) {
      if ($(ids[i])) $(ids[i]).readOnly = derived;
    }
    updateScaleNote(derived);
  }
  // 根据当前模式和最新画布上下文决定「生成预览」按钮的可用状态与文案。
  // 选区编辑模式下没有选区时，按钮变灰并提示用户先框选，避免点击后才报错。
  function updateRunButton(busyOverride) {
    var runBtn = $('run');
    if (!runBtn) return;
    var mode = controller.state().mode;
    var busy = busyOverride !== undefined ? busyOverride
      : (['preparing', 'submitting', 'running'].indexOf(controller.state().status) >= 0);
    // 选区编辑模式 + 无选区 → 按钮置灰并换文案；忙碌时按原逻辑 disabled，不改文案
    var needsSelection = (mode === 'edit') && lastCtx && !lastCtx.selectionBounds && !busy;
    if (busy) {
      runBtn.disabled = true;
      // 文案在 render() 里管（重试 / 生成预览），这里不干扰
    } else if (needsSelection) {
      runBtn.disabled = true;
      runBtn.textContent = '请先框选区域';
    } else {
      runBtn.disabled = false;
      var s = controller.state();
      var label = s.status === 'error' ? '重试' : '生成预览';
      if (runBtn.textContent !== label) runBtn.textContent = label;
    }
  }
  function render(state) {
    // 扩图比例可能由画布透明边自动推导，回填到输入框，避免界面显示的值和实际用的值不一致。
    if (state.appliedScales) {
      $('top').value = fmtScale(state.appliedScales.top);
      $('right').value = fmtScale(state.appliedScales.right);
      $('bottom').value = fmtScale(state.appliedScales.bottom);
      $('left').value = fmtScale(state.appliedScales.left);
    }
    setScalesDerived(!!state.scalesDerived);
    // 默认不写教学文案：状态栏只承载「进行中 / 出错 / 完成」，
    // 空着比反复念一遍「结果会先在这里预览」更安静，也不会和按钮说法打架。
    var busy = ['preparing', 'submitting', 'running'].indexOf(state.status) >= 0;
    if (busy && !busySince) busySince = Date.now();
    if (!busy) busySince = 0;
    busyState = state;
    $('status').textContent = statusText(state);
    $('status').className = 'status' + (state.status === 'error' ? ' error' : state.status === 'applied' ? ' ok' : '');
    // 失败后把按钮改成「重试」。上游抖动这类错误九成是再点一次就好，
    // 按钮还写着「生成预览」的话，用户会以为得先改点什么配置才能继续。
    updateRunButton(busy);
    $('cancel').classList.toggle('hidden', state.status !== 'running');
    renderPreviews(state);
  }
  setInterval(function () { if (busySince && busyState) $('status').textContent = statusText(busyState); }, 1000);
  function showError(error) { busySince = 0; $('status').textContent = error.message || '操作失败。'; $('status').className = 'status error'; }
  // 「更多选项」里没有可见项时整块收起来，不留一个点开是空的 ＋。
  function hideEmptyAdvanced() {
    var rows = $('advanced').querySelectorAll('.advanced-fields > label');
    var anyShown = false;
    for (var i = 0; i < rows.length; i++) if (!rows[i].classList.contains('hidden')) anyShown = true;
    $('advanced').classList.toggle('hidden', !anyShown);
  }
  function modeChanged(mode) {
    controller.setMode(mode);
    // 换了模式，上次推导出来的倍率就不作数了：不清掉的话，切到「生成」再切回
    // 「扩图」，框里还留着上一张画布的读数，看着像刚算出来的。
    setScalesDerived(false);
    var buttons = document.querySelectorAll('.mode');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('active', buttons[i].getAttribute('data-mode') === mode);
    $('expand-directions').classList.toggle('hidden', mode !== 'expand');
    $('whole-row').classList.toggle('hidden', mode !== 'edit');
    $('size-row').classList.toggle('hidden', mode !== 'generate');
    $('strength-row').classList.toggle('hidden', mode !== 'edit' || !$('whole').checked);
    // 三个短参数已提到常显的参数行，这层只剩条件项。CEP 的「生成」模式一个条件项都不出现，
    // 留一个点开是空的 ＋，比直接不显示更容易让人以为面板坏了。
    hideEmptyAdvanced();
    $('prompt-hint').textContent = mode === 'generate' || (mode === 'edit' && $('whole').checked) ? '必填' : '可留空';
    // 扩图这一栏的措辞很要紧：写「右边加一盏台灯」它就会真的画一盏新的，右边立刻多出东西。
    // 提示里那句「只写材质和光线、别列物体」放在描述框下面的说明里（跟着输入框一起可见），
    // 占位符只留一个短例子——长句会整个被截断，还占满输入区。
    $('prompt').placeholder = mode === 'expand'
      ? '扩图：只写延伸区域的材质与光线（如：海边日落余晖、深色木地板延续），避免列新物体'
      : mode === 'generate'
        ? '文生图：输入画面主体、构图与艺术风格（如：极简陶瓷花瓶，柔和摄影光）'
        : '选区编辑：留空自然补全，写描述局部重绘（如：把选区里的杯子换成白色花瓶）';
    // 切换模式后按选区状态重新评估按钮——用户很可能在没有选区时切到「选区编辑」。
    updateRunButton();
  }
  function values() {
    return {
      mode: controller.state().mode, prompt: $('prompt').value, whole: $('whole').checked,
      strength: $('strength').value, n: Number($('count').value), size: $('size').value, seed: $('seed').value,
      scales: { top: Number($('top').value), right: Number($('right').value), bottom: Number($('bottom').value), left: Number($('left').value) }
    };
  }
  // 文档信息是副标：只留「多大、有没有选区」这两个直接影响下一步操作的量。
  // RGB 位深和脚本版本号只在排查时有用，收进 tooltip——它们每帧都在那儿、却从不改变操作。
  function refreshDocument() {
    host.inspect().then(function (ctx) {
      lastCtx = ctx;
      var text = ctx.width + ' × ' + ctx.height + (ctx.selectionBounds ? ' · 有选区' : ' · 无选区');
      $('document').textContent = text;
      $('document').title = text + ' · RGB 8 位' + (ctx.build ? ' · 脚本 ' + ctx.build : '');
      updateRunButton();
    }, function (error) { $('document').textContent = error.message; });
  }
  // 面板加载后用户仍在 Photoshop 里改画布、拉选区，信息栏必须跟上，否则会一直显示旧状态。
  function liveRefresh() {
    refreshDocument();
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

  // 顶部渠道条：打开面板就能看到「连没连上 / 走哪个渠道 / 当前模型」。
  // 这些信息原来只埋在设置页里，用户往往是点了生成、失败之后才发现 Key 没填。
  // 文案判定在共享模块里（两端同一份），这里只管把结果画到 DOM 上。
  var serviceReady = false;
  var ensurePromise = null;
  // 「连接码不对」和「服务没起来」要分开：前者只能重填，后者面板能自己救。
  var providerNeedsManualToken = false;

  // 一行拆两段：label 是固定类别，detail 是变化的那半截（模型名 / 下一步动作）。
  // detail 由 CSS 画成胶囊并用 tone 上色，所以状态色只出现在这里。
  function setProviderLine(label, detail, tone) {
    var button = $('provider');
    $('provider-label').textContent = label;
    $('provider-chip').textContent = detail || '';
    button.className = 'provider' + (tone ? ' ' + tone : '');
    button.title = (detail ? label + ' · ' + detail : label) + '　点击查看或修改';
  }
  function openSettings() { $('settings').classList.remove('hidden'); channelView.load(); }

  // 服务把连接码写在 %LOCALAPPDATA%\Studio AI Image\client-token（权限 0600）。
  // 读它和用户手工抄一遍是同一个授权边界——都是「能读当前用户 profile 的进程」，
  // 所以自动化不降低安全性，只是去掉了一步复制粘贴。
  function adoptToken() {
    var token = launcher.readToken();
    if (token) { try { service.setToken(token); } catch (e) {} }
    return token;
  }
  function ensureService() {
    if (serviceReady) return Promise.resolve();
    // 连点两次生成会同时触发两个 ensure，复用同一个 Promise，否则会拉起两个服务进程。
    if (ensurePromise) return ensurePromise;
    ensurePromise = launcher.ensure().then(function (result) {
      ensurePromise = null;
      serviceReady = true;
      try { service.setToken(result.token); } catch (e) {}
    }, function (error) {
      ensurePromise = null;
      throw error;
    });
    return ensurePromise;
  }
  function startServiceFromPanel() {
    setProviderLine('本地服务', '正在启动…', 'warn');
    $('settings-status').textContent = '正在启动本地服务…';
    ensureService().then(function () {
      $('settings-status').textContent = '本地服务已启动。';
      refreshProvider();
    }, function (error) {
      setProviderLine('本地服务', error.message, 'error');
      $('settings-status').textContent = error.message;
    });
  }

  function refreshProvider() {
    setProviderLine('本地服务', '正在检查…', '');
    service.channel().then(function (view) {
      serviceReady = true;
      providerNeedsManualToken = false;
      var info = StudioChannelView.providerSummary(view);
      setProviderLine(info.label, info.detail, info.tone);
      $('provider').title = info.text + '　点击查看或修改';
      $('settings-status').textContent = info.tone === 'ok' ? '本地服务已连接。' : '已连接本地服务，但生成渠道还没配全。';
    }, function (error) {
      serviceReady = false;
      var message = (error && error.message) || '';
      providerNeedsManualToken = /连接码无效/.test(message);
      if (providerNeedsManualToken) {
        setProviderLine('连接码无效', '点此重新填写', 'error');
      } else if (launcher.canLaunch()) {
        // 用 warn 而不是 error：这一档点一下就能自愈，红点会让人以为坏了。
        setProviderLine('本地服务未启动', '点此启动', 'warn');
      } else {
        setProviderLine('本地服务未启动', '点此查看', 'error');
      }
      $('provider').title = message || '无法连接本地服务';
      $('settings-status').textContent = providerNeedsManualToken
        ? '连接码无效，请在下方重新填写。'
        : (launcher.canLaunch() ? '本地服务未启动，点上方「启动本地服务」。' : '请手动启动本地服务，并在下方填写连接码。');
    });
  }

  var buttons = document.querySelectorAll('.mode');
  for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', function () { modeChanged(this.getAttribute('data-mode')); });
  $('whole').addEventListener('change', function () { modeChanged(controller.state().mode); });
  // 快捷键：Ctrl+Enter / Cmd+Enter 快速触发生成，符合专业修图师盲操肌肉记忆
  $('prompt').addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (event.preventDefault) event.preventDefault();
      if (!$('run').disabled) $('run').click();
    }
  });
  // 手动调倍率时实时刷新双向预警
  ['top', 'right', 'bottom', 'left'].forEach(function (id) {
    if ($(id)) $(id).addEventListener('input', function () { updateScaleNote(false); });
  });
  // 键盘快捷键体系（P2）：
  // 1. 大图预览开启时：数字键 1~4 盲操切图
  // 2. 主面板显示结果卡片时：数字键聚焦卡片、Enter 应用当前卡片、Space 打开对比、[ / ] 翻页历史批次
  document.addEventListener('keydown', function (event) {
    // Enter / 空格 / 数字键在控件聚焦时属于控件自己。以前这里只挡了输入框，
    // Tab 到「取消」「生成」按钮再按 Enter，会被抢去执行「应用结果」把图贴回
    // 原图——不可逆误操作。按钮、链接、可编辑区一律放行给它们的原生行为。
    var active = document.activeElement;
    var activeTag = active ? active.tagName.toUpperCase() : '';
    var isControlFocused = !!active && (
      activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT'
      || activeTag === 'BUTTON' || activeTag === 'A' || activeTag === 'SUMMARY'
      || active.isContentEditable === true
      || (typeof active.getAttribute === 'function' && active.getAttribute('contenteditable') !== null)
    );
    if (!isControlFocused && compare.state().open && lastState && lastState.previews && lastState.previews.length > 1) {
      var n = parseInt(event.key, 10);
      if (n >= 1 && n <= lastState.previews.length) {
        openViewer(n - 1);
        if (event.preventDefault) event.preventDefault();
        return;
      }
    }
    if (!compare.state().open && !isControlFocused && lastState && lastState.status === 'preview' && previewCards.length > 0) {
      var num = parseInt(event.key, 10);
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
  $('history-prev').addEventListener('click', function () { controller.navHistory(-1); });
  $('history-next').addEventListener('click', function () { controller.navHistory(1); });
  $('run').addEventListener('click', function () {
    liveRefresh();
    // 第一次点生成就地拉起服务：用户不必先回顶部点「启动」，再回来点生成。
    ensureService().then(function () { return controller.run(values()); }, function (error) {
      setProviderLine('本地服务', error.message, 'error');
      throw error;
    }).catch(showError);
  });
  $('cancel').addEventListener('click', function () { controller.cancel().catch(showError); });
  // 文档状态只能靠 evalScript 去问 Photoshop，没有可用的变更事件。所以轮询要保留，
  // 但把频率降下来、且只在面板可见并空闲时刷新：原来 5 秒一次无条件往返，
  // 面板整天挂着就整天在做无意义的 evalScript。回到面板时也会立刻刷一次，
  // 不必靠高频轮询来补实时性。
  var refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      var status = controller.state().status;
      var busy = status === 'preparing' || status === 'submitting' || status === 'running';
      if (!busy && !document.hidden) liveRefresh();
      scheduleRefresh();
    }, 15000);
  }
  window.addEventListener('focus', function () { liveRefresh(); refreshProvider(); scheduleRefresh(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) liveRefresh(); });
  scheduleRefresh();
  // 渠道切换放在面板里：用户换中转站/换模型不用再改 openai.env、不用重开终端。
  var channelView = StudioChannelView.createChannelView({ $: $, service: service });
  channelView.bind();
  $('settings-toggle').addEventListener('click', function () {
    var hidden = $('settings').classList.toggle('hidden');
    // 每次打开设置页都重新拉一次：渠道可能在别处（另一台面板、改过配置文件）已经变了。
    if (!hidden) channelView.load();
  });
  $('settings-close').addEventListener('click', function () { $('settings').classList.add('hidden'); refreshProvider(); });
  // 整条可点：状态是「未连接」「未填 Key」时，用户的第一反应就是去改，别让他找齿轮。
  $('provider').addEventListener('click', function () {
    // 服务没起来、面板又能自己拉 → 就地启动；其余情况（码不对 / 只是想改渠道）进设置页。
    if (!serviceReady && !providerNeedsManualToken && launcher.canLaunch()) { startServiceFromPanel(); return; }
    openSettings();
  });
  $('start-service').addEventListener('click', function () { startServiceFromPanel(); });
  $('save-token').addEventListener('click', function () {
    try {
      service.setToken($('client-token').value);
      $('client-token').value = '';
      service.status().then(function () {
        serviceReady = true;
        providerNeedsManualToken = false;
        $('settings-status').textContent = '本地服务已连接。';
        refreshProvider();
        channelView.load();
      }, function (error) { serviceReady = false; $('settings-status').textContent = error.message; refreshProvider(); });
    } catch (error) { $('settings-status').textContent = error.message; }
  });
  // 面板一打开就自动配对：先读服务写好的连接码，再探活。都成功的话用户什么都不用填。
  adoptToken();
  refreshProvider();
  cs.addEventListener('org.studio.aiimg.quick', quickRoute);
  window.addEventListener('unload', function () { controller.dispose(); });
  modeChanged('edit');
  refreshDocument();
}());
