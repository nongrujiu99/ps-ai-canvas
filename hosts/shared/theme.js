/* 主题切换 · CEP 与 UXP 共用（两份副本逐字节一致，panel-parity.test.js 会断言）
 *
 * 四种模式：auto / dark / light / ps
 *   auto  → 解析成 dark 或 light，跟随系统（没有 matchMedia 时退回 dark）
 *   dark  → 不写 data-theme（:root 里的默认值就是深色）
 *   light / ps → <html data-theme="light|ps">
 *
 * 为什么不用 CSS 的 @media(prefers-color-scheme)：那样用户改不了，而且「PS 灰」这种
 * 自定义主题根本表达不出来。自动模式的解析交给 JS，CSS 只认一个显式属性。
 *
 * 这个文件同时被两种方式加载：CEP 用 <script>（挂到 window.StudioTheme），
 * UXP 用 require（走 module.exports）。所以两边都不用宿主特有的东西，
 * document / localStorage / matchMedia 全部做存在性判断。
 */
(function () {
  'use strict';

  var KEY = 'studio-ai-image.theme';
  var MODES = ['auto', 'dark', 'ps', 'light'];
  var current = 'auto';
  var bound = false;

  function doc() { return typeof document === 'undefined' ? null : document; }

  function store() {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch (e) { return null; }
  }
  function read() {
    var s = store();
    var value = s && s.getItem(KEY);
    return MODES.indexOf(value) >= 0 ? value : 'auto';
  }
  function write(mode) {
    var s = store();
    try { if (s) s.setItem(KEY, mode); } catch (e) { /* 存不了就只在本次会话生效 */ }
  }

  function prefersLight() {
    try {
      return !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme:light)').matches);
    } catch (e) { return false; }
  }

  function resolve(mode) {
    return mode === 'auto' ? (prefersLight() ? 'light' : 'dark') : mode;
  }

  // dark 对应「没有属性」：这样 :root 里的默认值就是一套完整的深色，
  // 脚本没跑起来也不会出现半套变量。
  function paint(mode) {
    var d = doc();
    var actual = resolve(mode);
    if (!d || !d.documentElement) return actual;
    if (actual === 'dark') d.documentElement.removeAttribute('data-theme');
    else d.documentElement.setAttribute('data-theme', actual);
    return actual;
  }

  function markActive(mode) {
    var d = doc();
    if (!d) return;
    var buttons = d.querySelectorAll('[data-theme-value]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-theme-value') === mode);
    }
  }

  function apply(mode) {
    current = MODES.indexOf(mode) >= 0 ? mode : 'auto';
    write(current);
    paint(current);
    markActive(current);
    return current;
  }

  function bind() {
    var d = doc();
    if (!d || bound) return;
    bound = true;
    markActive(current);

    var buttons = d.querySelectorAll('[data-theme-value]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        apply(this.getAttribute('data-theme-value'));
      });
    }

    // 「自动」要跟着系统走：两个方向的切换都得听。
    try {
      if (typeof matchMedia !== 'function') return;
      var mq = matchMedia('(prefers-color-scheme:light)');
      var onChange = function () { if (current === 'auto') paint(current); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) { /* 没有 matchMedia 就固定在解析出来的那一档 */ }
  }

  function init() {
    current = read();
    paint(current);   // 尽早着色，早于首帧绘制就不会先闪一下深色
    bind();
    return current;
  }

  // 脚本放在 </body> 前（CEP）或在 DOM 就绪后 require（UXP）时，按钮已经在 DOM 里。
  // 万一是 <head> 里先跑起来，就等 DOM 就绪再绑，颜色仍然先上。
  var d = doc();
  if (d && d.readyState === 'loading' && !d.querySelector('[data-theme-value]')) {
    current = read();
    paint(current);
    d.addEventListener('DOMContentLoaded', bind);
  } else {
    init();
  }

  var api = { apply: apply, init: init, current: function () { return current; }, resolve: resolve, modes: MODES.slice() };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.StudioTheme = api;
}());
