const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const cssPath = path.join(root, 'shared', 'panel.css');
const raw = fs.readFileSync(cssPath, 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

// 规范写在 docs/ui-style-guide.md 里，但「写下来」拦不住任何人。
// 这个文件把规范里最容易破的四条变成会失败的断言：
//   1. Chromium 61 黑名单语法（降级是静默的，界面只是"没生效"，很难查）
//   2. 字号 / 圆角必须落在既有阶梯内（否则界面开始长出第二套比例）
//   3. 不透明颜色只能是 :root 里的 token（否则换主题时会有元素不跟）
//   4. 模板骨架里的 class 必须真实存在（否则复制过去是个死的）
// 改规范里这些数值时，同步改这里的白名单——两处不一致本身就是错误。

const FONT_SIZES = new Set(['10', '11', '11.5', '12', '12.5', '13', '14']);
const RADII = new Set(['0', '1px', '2px', '3px', '4px', '5px', '6px', '7px', '8px', '9px', '10px', '50%']);

test('panel.css 不包含 Chromium 61 不支持的语法', () => {
  const banned = [
    [/:has\(/, ':has() 需要 Chromium 105+'],
    [/:is\(/, ':is() 需要 Chromium 88+'],
    [/:where\(/, ':where() 需要 Chromium 88+'],
    [/clamp\(/, 'clamp() 需要 Chromium 79+'],
    [/conic-gradient/, 'conic-gradient 需要 Chromium 69+'],
    [/accent-color/, 'accent-color 需要 Chromium 93+'],
    [/aspect-ratio/, 'aspect-ratio 需要 Chromium 88+'],
    [/(?<![-\w])inset\s*:/, 'inset 简写需要 Chromium 87+，请写 top/right/bottom/left'],
    [/(?<!min)max\(/, 'max() 需要 Chromium 79+'],
    [/(?<![-\w])min\(/, 'min() 需要 Chromium 79+'],
    [/(?<!grid-)gap\s*:/, 'flex/grid 的 gap 简写需要 Chromium 66+，请写 grid-gap']
  ];
  const hits = banned.filter(([re]) => re.test(css)).map(([, why]) => why);
  assert.deepEqual(hits, [], '这些规则在 PS 2018–2020 的 CEP 上会被整条丢弃：\n  ' + hits.join('\n  '));
});

test('字号只能取规范阶梯里的值', () => {
  const found = new Set([...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1]));
  const extra = [...found].filter((v) => !FONT_SIZES.has(v)).sort();
  assert.deepEqual(extra, [], '出现了阶梯外的字号：' + extra.join(', ') +
    'px。若确实需要新档位，先改 docs/ui-style-guide.md 2.1 节并说明理由。');
});

test('圆角只能取规范阶梯里的值', () => {
  const found = new Set();
  for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
    // 简写如 border-radius:6px 已覆盖；分写法（左上/右下）取不到，规范里也不用
    for (const part of m[1].trim().split(/\s+/)) found.add(part);
  }
  const extra = [...found].filter((v) => !RADII.has(v)).sort();
  assert.deepEqual(extra, [], '出现了阶梯外的圆角：' + extra.join(', ') +
    '。阶梯见 docs/ui-style-guide.md 3.2 节。');
});

test('不透明颜色只能来自 :root 的 token', () => {
  // 把 :root 块挖掉，剩下的地方出现不透明色值就意味着「没有走 token」，
  // 换主题时这块不会跟，浅色下会留下一块深色。
  const outside = css.replace(/:root(?:\[[^\]]*\])?\{[^}]*\}/g, '');
  const ALLOWED_HEX = new Set(['#fff']); // 预览图上的序号角标：叠加在图上，必须与图上内容解耦
  const hex = [...outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  const badHex = [...new Set(hex)].filter((h) => !ALLOWED_HEX.has(h.toLowerCase()));
  assert.deepEqual(badHex, [], '这些字面色值应该改成 var(--token)：' + badHex.join(', '));

  const rgbOpaque = [...css.matchAll(/rgba?\([^)]*\)/g)]
    .map((m) => m[0])
    .filter((v) => !v.startsWith('rgba(') || /,\s*1(\.0*)?\s*\)$/.test(v));
  assert.deepEqual([...new Set(rgbOpaque)], [],
    '不透明 rgb() 应该改成 var(--token)；只有半透明叠加（光晕、遮罩、渐变）允许用 rgba。');
});

test('焦点线用 inset 阴影画，不用 outline 边框', () => {
  // Chromium 61 的 outline 永远是直角，套在圆角控件上像贴了张方纸；outline-offset 还会伸出容器。
  // 所以焦点一律 box-shadow:inset（跟随圆角），outline 只用来清零浏览器默认框。
  const values = [...new Set([...css.matchAll(/outline:\s*([^;}]+)/g)].map((m) => m[1].trim()))];
  const bad = values.filter((v) => v !== '0' && v !== 'none');
  assert.deepEqual(bad, [], '这些 outline 用了实际线条（直角 + 破坏圆角）：' + bad.join(', ') +
    '。焦点请改用 box-shadow:inset 0 0 0 1px var(--focus-line)。');
  assert.equal(/outline-offset/.test(css), false,
    '出现了 outline-offset：说明又在用 outline 画焦点框了。Chromium 61 下它是直角且会溢出容器。');
});

test('var() 引用的 token 都已在 :root 定义', () => {
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v)).sort();
  assert.deepEqual(missing, [], '这些 token 没有定义，会用成透明/继承值：' + missing.join(', '));
});
test('三套主题（深/浅/PS 灰）定义了同一组 token', () => {
  // 少一个 token 不会报错，只会「某个控件在新主题下还是旧主题的颜色」——最难查的一类问题。
  const block = (attr) => {
    const re = new RegExp(':root' + (attr ? '\\[data-theme="' + attr + '"\\]' : '') + '\\{([^}]*)\\}');
    const m = css.match(re);
    return m ? new Set([...m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1])) : new Set();
  };
  const base = block('');
  const light = block('light');
  const ps = block('ps');
  assert.ok(base.size > 10, '没解析到 :root 的 token 列表');
  for (const [name, set] of [['浅色', light], ['PS 灰', ps]]) {
    const missing = [...base].filter((t) => !set.has(t)).sort();
    assert.deepEqual(missing, [], name + '主题缺这些 token（会沿用深色值）：' + missing.join(', '));
    const extra = [...set].filter((t) => !base.has(t)).sort();
    assert.deepEqual(extra, [], name + '主题多出这些 token（深色里没有，等于死值）：' + extra.join(', '));
  }
});

test('模板骨架里的 class 都能在 panel.css 找到定义', () => {
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const skeleton = fs.readFileSync(path.join(root, '..', 'docs', 'ui-template', 'skeleton.html'), 'utf8');
  const used = new Set();
  for (const m of skeleton.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  const missing = [...used].filter((c) => !defined.has(c)).sort();
  assert.deepEqual(missing, [], '模板里用了不存在的 class（复制过去不会有样式）：' + missing.join(', '));
});

// ── DOM 结构守卫 ──────────────────────────────────────────────
// 两端共用一份 panel.js / panel.css，DOM id 就是它俩的接口。id 一旦悄悄分叉，
// 症状是「某个按钮在一端没反应」而不是报错——曾经真的发生过。
const htmlIds = (rel) => new Set(
  [...fs.readFileSync(path.join(root, rel), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
);

// 必须与规范 5.5 节的登记表逐字一致。差异可以有，但必须是被思考和登记过的差异。
const HOST_DOM_DIFF = { cep: ['start-service'], uxp: ['cost-confirm'] };

test('CEP 与 UXP 的 DOM 差异与规范 5.5 节的登记表一致', () => {
  const cep = htmlIds(path.join('cep', 'index.html'));
  const uxp = htmlIds(path.join('uxp', 'index.html'));
  const onlyCep = [...cep].filter((x) => !uxp.has(x)).sort();
  const onlyUxp = [...uxp].filter((x) => !cep.has(x)).sort();
  assert.deepEqual(onlyCep, [...HOST_DOM_DIFF.cep].sort(),
    'CEP 独有的 id 与登记表不符。若是有意的结构差异，请先改规范 5.5 节和这里的 HOST_DOM_DIFF。');
  assert.deepEqual(onlyUxp, [...HOST_DOM_DIFF.uxp].sort(),
    'UXP 独有的 id 与登记表不符。若是有意的结构差异，请先改规范 5.5 节和这里的 HOST_DOM_DIFF。');
});

test('模板骨架覆盖两端面板的全部 id', () => {
  // 骨架是「照抄就能用」的东西。少一个 id，复制过去就是一个点了没反应的按钮。
  // 口径是 CEP ∪ UXP 的并集：骨架保持全量，落地时按 5.5 节的差异表删掉不属于当前端的那 1~2 行。
  const real = new Set([
    ...htmlIds(path.join('cep', 'index.html')),
    ...htmlIds(path.join('uxp', 'index.html'))
  ]);
  const skeleton = htmlIds(path.join('..', 'docs', 'ui-template', 'skeleton.html'));
  const missing = [...real].filter((x) => !skeleton.has(x)).sort();
  assert.deepEqual(missing, [], '骨架缺这些 id（复制过去会丢功能）：' + missing.join(', '));
  const extra = [...skeleton].filter((x) => !real.has(x)).sort();
  assert.deepEqual(extra, [], '骨架多出这些 id（两端面板里都没有，会误导后来者）：' + extra.join(', '));
});

// 结构守卫：三个「每次都要看的」参数必须在常显的参数行里，不能退回折叠区。
// 这条是从一次真实改动反推的——它们原来一人一行塞在「更多选项」里，每次生成都得先展开。
test('主面板的三个短参数在常显的参数行里，且不在折叠区', () => {
  for (const host of ['cep', 'uxp']) {
    const html = fs.readFileSync(path.join(root, host, 'index.html'), 'utf8');
    const row = html.match(/<div class="param-row">([\s\S]*?)<\/div>/);
    assert.ok(row, host + ' 缺少 .param-row（候选数量/随机种子/输出尺寸必须并排常显）');
    for (const id of ['count', 'seed', 'size']) {
      assert.ok(row[1].includes('id="' + id + '"'), host + ' 的参数行里缺少 #' + id);
    }
    const details = html.match(/<details id="advanced">([\s\S]*?)<\/details>/);
    assert.ok(details, host + ' 缺少 #advanced');
    for (const id of ['count', 'seed', 'size']) {
      assert.ok(!details[1].includes('id="' + id + '"'),
        host + ' 把 #' + id + ' 又塞回「更多选项」了——它是常显参数，不是高级项');
    }
  }
});

// 渠道行改成「类别 + 状态胶囊」两段。退回一整句话时状态色只能落在正文上，
// 整行会跟着变色、和下面的模式框抢注意力——这条正是从一次界面收拾里定下来的。
test('渠道行是「类别 + 状态胶囊」两段，不是一整句话', () => {
  for (const host of ['cep', 'uxp']) {
    const html = fs.readFileSync(path.join(root, host, 'index.html'), 'utf8');
    const row = html.match(/<button id="provider"[\s\S]*?<\/button>/);
    assert.ok(row, host + ' 找不到渠道行 #provider');
    assert.ok(row[0].includes('id="provider-label"'), host + ' 渠道行缺少 #provider-label');
    assert.ok(row[0].includes('id="provider-chip"'), host + ' 渠道行缺少 #provider-chip');
    assert.equal(/id="provider-text"/.test(row[0]), false, host + ' 还留着 #provider-text（一整句话的老结构）');
    assert.equal(/class="dot"/.test(row[0]), false,
      host + ' 渠道行还有独立指示灯：状态色只应出现在胶囊上，两处同时变色等于重复表达');
  }
});

// 十字布局不是 grid-area 写在 label 类上，而是 `label[for="top"]` 这类选择器钉住的。
// 把 for 改成别的值（或漏写），布局不会报错，只会静默退化成一横排——排查时很难往这想。
test('倍率十字的四个 label 必须按方向名绑定 for，布局依赖它', () => {
  for (const host of ['cep', 'uxp']) {
    const html = fs.readFileSync(path.join(root, host, 'index.html'), 'utf8');
    const grid = html.match(/<div id="scale-grid" class="scale-grid">([\s\S]*?)<\/div>/);
    assert.ok(grid, host + ' 缺少 #scale-grid');
    for (const dir of ['top', 'right', 'bottom', 'left']) {
      assert.ok(new RegExp('for="' + dir + '"').test(grid[1]), host + ' 的倍率 label 缺少 for="' + dir + '"');
      assert.ok(new RegExp('id="' + dir + '"').test(grid[1]), host + ' 缺少 #' + dir);
    }
  }
});

// 倍率框推导成功时是「读数」，但它仍然得是个框——而且要和可编辑时长得一样。
// 曾经用「边框透明」表达只读，真机上就只剩四个数字浮在标签右边，看着像控件没渲染出来。
// 现在的口径：框体不动，只把数字调灰。
test('只读倍率框保留实线框体，不许去边框或改成虚线', () => {
  const rule = css.match(/\.scale-grid\.derived\s+input\{([^}]*)\}/);
  assert.ok(rule, 'panel.css 里找不到 .scale-grid.derived input 规则');
  const body = rule[1].replace(/\s+/g, '');
  assert.ok(!/border(-(color|style|width))?:(transparent|none|0)/.test(body),
    '只读态动了边框：框会消失成一串裸数字，四个方向必须始终是实线框');
  assert.ok(!/border-style/.test(body), '只读态不要改边框样式，实线是四个方向统一的口径');
  assert.match(body, /color:var\(--text-dim\)/, '只读与可编辑的区别只剩数字颜色');
});
