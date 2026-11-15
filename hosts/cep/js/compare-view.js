(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioCompareView = api;
}(this, function () {
  'use strict';

  // 「原图 ↔ 生成后」叠放对比。
  //
  // 面板最宽 520px，候选卡最宽 320px 高，看接缝、看模型把哪个角改坏了都不够。
  // 所以点开图片进覆盖层，用一条竖线把两张图切开：左边底稿、右边结果，拖动竖线
  // 立刻能看出「多出来的是什么、原来的东西有没有被重画」。
  //
  // 两层图必须严格对齐，否则对比本身就在骗人。做法是：底图留在文档流里决定容器
  // 大小，结果图绝对定位、宽度由 JS 写成和容器等宽的像素值（--cmp-w）。为什么
  // 不用百分比：结果图被一个「只露出左半边」的裁切框包着，百分比会按裁切框算，
  // 图会被压扁。为什么不用 clip-path：UXP 的 CSS 子集不保证支持，且不支持时的
  // 表现是「整张结果盖住底图」——滑块拖了没反应，比没有这个功能更糟。
  //
  // 必须是 ES5（var + function）：PS 2021 之前的 CEP 内嵌 Chromium 61。

  // 结果和底稿的比例差超过这个值，叠放就不可能严丝合缝。这时如实说一句，
  // 比让用户盯着一条错位的接缝怀疑自己看错强。
  var RATIO_TOLERANCE = 0.02;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function ratioOf(image) {
    if (!image || !image.naturalWidth || !image.naturalHeight) return 0;
    return image.naturalWidth / image.naturalHeight;
  }

  function createCompareView(options) {
    var $ = options.$;
    var doc = options.document || (typeof document === 'undefined' ? null : document);
    var state = { open: false, compare: false, position: 50, index: 0, count: 1, before: null, after: null };
    var dragging = false;

    function show(id, visible) {
      var node = $(id);
      if (node) node.classList.toggle('hidden', !visible);
    }

    // 容器宽度 → --cmp-w。只在打开、切到对比、窗口改变尺寸时算，不做持续测量：
    // 面板宽度是人拖出来的，拖动时重算会一直打断图片重绘。
    function measure() {
      var box = $('compare');
      if (!box || !state.open || !state.compare) return;
      var width = box.clientWidth;
      if (width > 0) box.style.setProperty('--cmp-w', width + 'px');
    }

    function setPosition(value) {
      var next = clamp(Number(value) || 0, 0, 100);
      state.position = next;
      var box = $('compare');
      if (box) box.style.setProperty('--cmp-x', next + '%');
      var range = $('compare-range');
      if (range && Number(range.value) !== Math.round(next)) range.value = String(Math.round(next));
    }

    function positionFromEvent(event) {
      var box = $('compare');
      if (!box) return state.position;
      var rect = box.getBoundingClientRect();
      var clientX = event.touches && event.touches.length ? event.touches[0].clientX : event.clientX;
      if (!rect.width || typeof clientX !== 'number') return state.position;
      return ((clientX - rect.left) / rect.width) * 100;
    }

    // 关闭时把 src 摘掉：一张画布尺寸的图常有好几 MB，留着只是占内存。
    // 用 removeAttribute 而不是 src=''，后者会让浏览器回头去请求面板自己的地址。
    function clearImages() {
      var ids = ['compare-before', 'compare-after', 'viewer-photo'];
      for (var i = 0; i < ids.length; i++) {
        var node = $(ids[i]);
        if (node) node.removeAttribute('src');
      }
    }

    function note() {
      var node = $('viewer-note');
      if (!node) return;
      if (!state.before) {
        node.textContent = '这次是纯生成：没有可以对照的原图。';
        return;
      }
      var before = $('compare-before'), after = $('compare-after');
      var a = ratioOf(before), b = ratioOf(after);
      if (a && b && Math.abs(a - b) / a > RATIO_TOLERANCE) {
        node.textContent = '结果比例和原图不同，重叠只是近似——接缝位置以真实结果为准。';
        return;
      }
      node.textContent = '拖动竖线对比：左边是原图，右边是生成后。方向键可微调。';
    }

    function paint() {
      var hasBefore = !!state.before && state.compare;
      show('compare', hasBefore);
      show('compare-bar', hasBefore);
      show('viewer-photo', !hasBefore);
      var toggle = $('viewer-compare');
      if (toggle) {
        toggle.classList.toggle('hidden', !state.before);
        toggle.textContent = state.compare ? '只看结果' : '对比原图';
      }
      note();
      if (hasBefore) measure();
    }

    function open(view) {
      view = view || {};
      if (!view.after) return;
      state.after = view.after;
      state.before = view.before || null;
      state.compare = !!state.before;
      state.index = view.index || 0;
      state.count = view.count || 1;
      var title = '结果预览';
      if (state.count > 1) title += ' · ' + (state.index + 1) + '/' + state.count;
      if ($('viewer-title')) $('viewer-title').textContent = title;
      if ($('compare-before')) $('compare-before').src = state.before || '';
      if ($('compare-after')) $('compare-after').src = state.after;
      if ($('viewer-photo')) $('viewer-photo').src = state.after;
      // 必须先让覆盖层可见再量宽度：display:none 的元素 clientWidth 是 0，
      // 顺序反过来会让结果图退回 100%，两张图宽度不一致，叠放直接错位。
      show('viewer', true);
      state.open = true;
      setPosition(50);
      paint();
      // 焦点落到关闭键：键盘用户打开覆盖层后得有落点，否则 Tab 会从面板顶部重新走。
      try { $('viewer-close').focus(); } catch (e) {}
    }

    function close() {
      state.open = false;
      show('viewer', false);
      clearImages();
    }

    function toggleCompare() {
      if (!state.before) return;
      state.compare = !state.compare;
      paint();
    }

    function bind() {
      if (!doc) return;
      if ($('viewer-close')) $('viewer-close').onclick = close;
      if ($('viewer-compare')) $('viewer-compare').onclick = toggleCompare;
      if ($('compare-range')) $('compare-range').oninput = function () { setPosition(this.value); };
      // 竖线本身不接鼠标：让整个图片区都能拖，从任意位置按下都比必须抓住那 2px 好。
      var box = $('compare');
      if (box) {
        box.onmousedown = function (event) {
          if (!state.open || !state.compare) return;
          dragging = true;
          setPosition(positionFromEvent(event));
          if (event.preventDefault) event.preventDefault();
        };
        box.ontouchstart = function (event) { dragging = true; setPosition(positionFromEvent(event)); };
        box.ontouchmove = function (event) { if (!dragging) return; setPosition(positionFromEvent(event)); if (event.preventDefault) event.preventDefault(); };
        box.ontouchend = function () { dragging = false; };
      }
      if (doc.addEventListener) {
        doc.addEventListener('mousemove', function (event) { if (dragging) setPosition(positionFromEvent(event)); });
        doc.addEventListener('mouseup', function () { dragging = false; });
        doc.addEventListener('keydown', function (event) {
          if (!state.open) return;
          if (event.key === 'Escape') { close(); return; }
          if (!state.compare) return;
          if (event.key === 'ArrowLeft') { setPosition(state.position - 2); if (event.preventDefault) event.preventDefault(); }
          if (event.key === 'ArrowRight') { setPosition(state.position + 2); if (event.preventDefault) event.preventDefault(); }
        });
      }
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', measure);
      }
      // 图加载完才知道真实比例，比例不一致的提醒要等这一刻。
      if ($('compare-after')) $('compare-after').onload = function () { note(); measure(); };
      if ($('compare-before')) $('compare-before').onload = function () { note(); measure(); };
    }

    return { bind: bind, open: open, close: close, toggleCompare: toggleCompare, setPosition: setPosition, state: function () { return state; } };
  }

  return { createCompareView: createCompareView };
}));
