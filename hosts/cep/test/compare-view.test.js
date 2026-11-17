const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompareView } = require('../js/compare-view');

const IDS = ['viewer', 'viewer-title', 'viewer-compare', 'viewer-close', 'compare', 'compare-before', 'compare-after', 'viewer-photo', 'compare-bar', 'compare-range', 'viewer-note'];

// 只做这个模块用到的那点 DOM：classList.toggle、style.setProperty、宽度读数、
// 以及 removeAttribute（关掉时要把几 MB 的图摘掉）。不引 jsdom：CEP 的 Chromium 61
// 行为和它也不一样，能测的是「我们自己的逻辑」，不是浏览器。
function fakeDom() {
  const nodes = {};
  for (const id of IDS) {
    const classes = new Set(id === 'viewer' || id === 'compare' || id === 'viewer-photo' || id === 'compare-bar' ? ['hidden'] : []);
    const props = {};
    nodes[id] = {
      id,
      classes,
      props,
      value: '',
      textContent: '',
      src: '',
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 340,
      onclick: null,
      onload: null,
      classList: {
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      style: { setProperty(name, value) { props[name] = value; } },
      getBoundingClientRect() { return { left: 0, width: 340 }; },
      removeAttribute(name) { if (name === 'src') this.src = ''; },
      focus() { this.focused = true; },
    };
  }
  const doc = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event || {})); },
  };
  const win = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    fire(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event || {})); },
  };
  return { $: (id) => nodes[id], nodes, doc, win };
}

function setup() {
  const dom = fakeDom();
  const view = createCompareView({ $: dom.$, document: dom.doc, window: dom.win });
  view.bind();
  return { dom, view, nodes: dom.nodes };
}

test('打开对比：两层图都摆上，竖线停在中间，滑杆跟着走', () => {
  const { view, nodes } = setup();
  view.open({ before: 'data:image/png;base64,before', after: 'data:image/png;base64,after', index: 1, count: 3 });

  assert.equal(nodes.viewer.classes.has('hidden'), false, '打开后覆盖层必须可见');
  assert.equal(nodes.compare.classes.has('hidden'), false);
  assert.equal(nodes['viewer-photo'].classes.has('hidden'), true, '有原图时不该显示单图');
  assert.equal(nodes['compare-before'].src, 'data:image/png;base64,before');
  assert.equal(nodes['compare-after'].src, 'data:image/png;base64,after');
  assert.equal(nodes['viewer-title'].textContent, '结果预览 · 2/3');
  assert.equal(nodes.compare.props['--cmp-x'], '50%');
  assert.equal(nodes['compare-range'].value, '50');
  // 结果图宽度必须写成容器的像素宽：它被「只露出左半边」的框包着，百分比会被压扁。
  assert.equal(nodes.compare.props['--cmp-w'], '340px');
});

test('单张结果不显示序号分母，标题保持简短', () => {
  const { view, nodes } = setup();
  view.open({ before: 'b', after: 'a', index: 0, count: 1 });
  assert.equal(nodes['viewer-title'].textContent, '结果预览');
});

test('纯生成没有原图时退化成单图，并说明为什么没有对比', () => {
  const { view, nodes } = setup();
  view.open({ after: 'data:image/png;base64,after', index: 0, count: 1 });

  assert.equal(nodes.compare.classes.has('hidden'), true, '没有原图就不该画一个拖不动的滑块');
  assert.equal(nodes['compare-bar'].classes.has('hidden'), true);
  assert.equal(nodes['viewer-photo'].classes.has('hidden'), false);
  assert.equal(nodes['viewer-photo'].src, 'data:image/png;base64,after');
  assert.equal(nodes['viewer-compare'].classes.has('hidden'), true, '没有可对比的图，切换按钮要收起来');
  assert.match(nodes['viewer-note'].textContent, /纯生成/);
});

test('拖动位置夹在 0~100 之间，滑杆与竖线始终是同一个值', () => {
  const { view, nodes } = setup();
  view.open({ before: 'b', after: 'a' });

  view.setPosition(72);
  assert.equal(nodes.compare.props['--cmp-x'], '72%');
  assert.equal(nodes['compare-range'].value, '72');

  view.setPosition(-30);
  assert.equal(nodes.compare.props['--cmp-x'], '0%');
  view.setPosition(300);
  assert.equal(nodes.compare.props['--cmp-x'], '100%');
  view.setPosition('不是数字');
  assert.equal(nodes.compare.props['--cmp-x'], '0%', '坏值不能把竖线甩到界外');
});

test('「只看结果」切走再切回，回来时重新量一次宽度', () => {
  const { view, nodes } = setup();
  view.open({ before: 'b', after: 'a' });
  nodes.compare.props['--cmp-w'] = '';

  nodes['viewer-compare'].onclick();
  assert.equal(nodes.compare.classes.has('hidden'), true);
  assert.equal(nodes['viewer-photo'].classes.has('hidden'), false);
  assert.equal(nodes['viewer-compare'].textContent, '对比原图');

  nodes['viewer-compare'].onclick();
  assert.equal(nodes.compare.classes.has('hidden'), false);
  assert.equal(nodes['viewer-compare'].textContent, '只看结果');
  assert.equal(nodes.compare.props['--cmp-w'], '340px');
});

test('关闭时把图摘掉，几 MB 的 data URL 不留在内存里', () => {
  const { view, nodes } = setup();
  view.open({ before: 'big-before', after: 'big-after' });
  nodes['viewer-close'].onclick();

  assert.equal(nodes.viewer.classes.has('hidden'), true);
  assert.equal(nodes['compare-before'].src, '');
  assert.equal(nodes['compare-after'].src, '');
  assert.equal(nodes['viewer-photo'].src, '');
});

test('结果比例和原图不一致时如实提醒，而不是让人对着错位的接缝怀疑自己', () => {
  const { view, nodes } = setup();
  view.open({ before: 'b', after: 'a' });
  nodes['compare-before'].naturalWidth = 2048;
  nodes['compare-before'].naturalHeight = 2048;
  nodes['compare-after'].naturalWidth = 2048;
  nodes['compare-after'].naturalHeight = 1152;
  nodes['compare-after'].onload();

  assert.match(nodes['viewer-note'].textContent, /比例和原图不同/);

  // 比例一致时回到正常提示，不能一直挂着警告。
  nodes['compare-after'].naturalHeight = 2048;
  nodes['compare-after'].onload();
  assert.match(nodes['viewer-note'].textContent, /拖动竖线/);
});

test('键盘：Esc 关闭，方向键每次 2%', () => {
  const { view, dom, nodes } = setup();
  view.open({ before: 'b', after: 'a' });

  dom.doc.fire('keydown', { key: 'ArrowRight' });
  assert.equal(nodes.compare.props['--cmp-x'], '52%');
  dom.doc.fire('keydown', { key: 'ArrowLeft' });
  dom.doc.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(nodes.compare.props['--cmp-x'], '48%');

  dom.doc.fire('keydown', { key: 'Escape' });
  assert.equal(nodes.viewer.classes.has('hidden'), true);
});

test('键盘：空格长按临时切原图，松开恢复', () => {
  const { view, dom, nodes } = setup();
  view.open({ before: 'b', after: 'a' });
  assert.equal(nodes.compare.props['--cmp-x'], '50%');

  dom.doc.fire('keydown', { key: ' ' });
  assert.equal(nodes.compare.props['--cmp-x'], '0%');

  dom.doc.fire('keyup', { key: ' ' });
  assert.equal(nodes.compare.props['--cmp-x'], '50%');
});

test('空格按住时窗口失焦：竖线自动复原，不卡在全是原图的骗人状态', () => {
  const { view, dom, nodes } = setup();
  view.open({ before: 'b', after: 'a' });
  view.setPosition(68);

  dom.doc.fire('keydown', { key: ' ' });
  assert.equal(nodes.compare.props['--cmp-x'], '0%', '按住空格切到原图');

  // Alt+Tab：document 收不到 keyup，只有 window 的 blur。
  dom.win.fire('blur');
  assert.equal(nodes.compare.props['--cmp-x'], '68%', '失焦必须恢复到按住前的位置');

  // 复原后再松开不能二次覆盖（keyup 此时应是无害的空操作）。
  dom.doc.fire('keyup', { key: ' ' });
  assert.equal(nodes.compare.props['--cmp-x'], '68%');

  // 失焦复原后重新按住，仍能记住新的起点。
  dom.doc.fire('keydown', { key: ' ' });
  dom.win.fire('blur');
  assert.equal(nodes.compare.props['--cmp-x'], '68%');
});
