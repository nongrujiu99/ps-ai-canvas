const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bridge() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jsx', 'bridge.jsx'), 'utf8').replace(/^#.*$/gm, '');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.Studio;
}

test('legacy bridge crops a large document around a small selection', () => {
  const area = bridge().workArea({ width: 10000, height: 8000, selectionBounds: { left: 6000, top: 4000, right: 6200, bottom: 4200 } });
  assert.equal(area.right - area.left, 712);
  assert.equal(area.bottom - area.top, 712);
  assert.ok(area.left <= 6000 && area.right >= 6200);
});

test('expandLayoutTolerant absorbs the 16px quantization into the right edge', () => {
  // 模型把输出宽量化到 16 的倍数：请求 1200*1.168≈1402，实际返回 1392
  const snapshot = { width: 1200, height: 800, scales: { left: 1, right: 1.168, top: 1, bottom: 1 } };
  const layout = bridge().expandLayoutTolerant(snapshot, 1392, 800);
  assert.deepEqual(JSON.parse(JSON.stringify(layout)), { left: 0, right: 192, top: 0, bottom: 0 });
  // 输出比画布还小 → 无法扩画布，交给「缩放贴合」那条路
  assert.equal(bridge().expandLayoutTolerant(snapshot, 1100, 800), null);
});

test('innerRect recovers the original photo area from right-side expansion scales', () => {
  // 画布 1152 宽，照片占左侧 906 px，只向右扩（right = 1152 / 906）
  const rect = bridge().innerRect({ width: 1152, height: 1136 }, { top: 1, right: 1152 / 906, bottom: 1, left: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(rect)), { left: 0, top: 0, right: 906, bottom: 1136 });
});

test('innerRect handles expansion on both sides', () => {
  // 左右各扩 25%：原图 768 宽，居中，left = 192
  const rect = bridge().innerRect({ width: 1152, height: 800 }, { top: 1, right: 1.25, bottom: 1, left: 1.25 });
  assert.deepEqual(JSON.parse(JSON.stringify(rect)), { left: 192, top: 0, right: 960, bottom: 800 });
});

test('innerRect refuses implausible scales', () => {
  // 比例全为 1 = 没有扩张，原图就是整张画布
  assert.deepEqual(JSON.parse(JSON.stringify(bridge().innerRect({ width: 1000, height: 1000 }, { top: 1, right: 1, bottom: 1, left: 1 }))), { left: 0, top: 0, right: 1000, bottom: 1000 });
  // 反解出来比画布还大 → 比例不可信，拒绝
  assert.equal(bridge().innerRect({ width: 1000, height: 1000 }, { top: 1, right: 0.5, bottom: 1, left: 1 }), null);
  assert.equal(bridge().innerRect({ width: 1000, height: 1000 }, null), null);
});

// 以下三个测试锁住「扩图落回原图层」的几何计算。
// 之所以不用「选区 + 清除/蒙版」而改成条带裁切：PS CC 2018 中文版上
// Dlt / Mk 两条 ActionManager 命令会报「该功能不在这个版本的 Photoshop 中使用」。
test('resolveInner prefers the layer bounds Photoshop itself reports', () => {
  const snapshot = {
    width: 2048, height: 2560,
    layerBounds: { left: 0, top: 0, right: 2048, bottom: 2560 },
    scales: { top: 1, right: 1.501, bottom: 1, left: 1 }
  };
  const inner = bridge().resolveInner(snapshot, { width: 3074, height: 2560 }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(inner)), { left: 0, top: 0, right: 2048, bottom: 2560 });
});

test('resolveInner falls back to scales when the layer covers the whole canvas', () => {
  const snapshot = {
    width: 1000, height: 1000,
    // 图层铺满画布 → 它不是「原照片」，这个范围信不过
    layerBounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
    scales: { top: 1, right: 1.5, bottom: 1, left: 1 }
  };
  const inner = bridge().resolveInner(snapshot, { width: 1500, height: 1000 }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(inner)), { left: 0, top: 0, right: 1000, bottom: 1000 });
});

test('newStrips keeps only the expanded border, with 1px overlap into the photo', () => {
  // 只向右边扩：唯一条带 = 照片右边界往内让 1px 到画布右边缘
  const frame = { width: 3074, height: 2560 };
  const strips = bridge().newStrips(frame, { left: 0, top: 0, right: 2048, bottom: 2560 });
  assert.deepEqual(JSON.parse(JSON.stringify(strips)), [{ left: 2047, top: 0, right: 3074, bottom: 2560 }]);
  // 没有扩张 → 一条条带都没有，调用方据此判断「无需裁切」
  assert.equal(bridge().newStrips(frame, { left: 0, top: 0, right: 3074, bottom: 2560 }).length, 0);
  // 四边都扩 → 4 条，且都落在画布内
  const four = JSON.parse(JSON.stringify(bridge().newStrips({ width: 840, height: 580 }, { left: 100, top: 50, right: 700, bottom: 450 })));
  assert.equal(four.length, 4);
  four.forEach((r) => {
    assert.ok(r.left >= 0 && r.top >= 0 && r.right <= 840 && r.bottom <= 580);
    assert.ok(r.right - r.left >= 1 && r.bottom - r.top >= 1);
  });
});

test('a result sized far off the canvas is rejected instead of being stretched onto it', () => {
  // 服务端约定返回「画布尺寸 + 只有新增区有像素」的图。尺寸差一截说明它没按约定来，
  // 硬拉伸只会得到一张变形的画面——宁可报错让结果单独打开，也不要贴一张糊图上去。
  const Studio = bridge();
  const far = { width: { as: () => 700 }, height: { as: () => 800 } };
  assert.throws(() => Studio.fitSourceToFrame(far, { width: 1000, height: 800 }), /尺寸/);
});

// ---- 扩图落位的假 DOM ----
// 这一段模拟 Photoshop 的对象模型，只实现 applyExpand 真正会碰的那几个成员。
// 目的：把「合并后扩图区整片透明」这类只在真机上才暴露的问题提前锁住。
// 关键点是 bounds——它是唯一能判断「像素实际落在哪里」的信号，所以假 DOM 让它严格
// 反映图层内容（而不是图层矩形），跟 PS 对普通像素图层的行为一致。

function uv(px) { return { as: () => px }; }

function fakeBridge(options) {
  const opts = options || {};
  const placement = opts.placement || { x: 0, y: 0 };
  const mergeBehaviour = opts.merge || 'ok';
  const translateEnabled = opts.translate !== false;
  const sandbox = {};
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '..', 'jsx', 'bridge.jsx'), 'utf8').replace(/^#.*$/gm, '');
  vm.runInContext(source, context);
  // ExtendScript 的全局在这一步注入：bridge.jsx 只在函数体里引用它们，
  // 所以先加载脚本、后补全局是可以的。
  // ExtendScript 里 UnitValue 既支持 new 也支持当函数调用，这里两种都伺候。
  context.UnitValue = function UnitValue(value) {
    if (!(this instanceof UnitValue)) return { value: value };
    this.value = value;
  };
  context.ElementPlacement = { PLACEATBEGINNING: 'beginning', PLACEBEFORE: 'before' };
  context.app = { activeDocument: null };
  let nextId = 1;

  function makeLayer(doc, content) {
    return {
      id: nextId++,
      typename: 'ArtLayer',
      kind: 1,
      parent: doc,
      name: '',
      content: { left: content.left, top: content.top, width: content.width, height: content.height },
      get bounds() {
        const c = this.content;
        return [uv(c.left), uv(c.top), uv(c.left + c.width), uv(c.top + c.height)];
      },
      translate(dx, dy) {
        if (!translateEnabled) return;
        this.content.left += dx.value;
        this.content.top += dy.value;
      },
      duplicate(target, where) {
        const copy = makeLayer(target, { left: placement.x, top: placement.y, width: this.content.width, height: this.content.height });
        if (where === 'beginning') target.layers.unshift(copy); else target.layers.push(copy);
        target.activeLayer = copy;
        return copy;
      },
      move(reference, where) {
        const arr = doc.layers;
        const from = arr.indexOf(this);
        if (from >= 0) arr.splice(from, 1);
        const to = arr.indexOf(reference);
        arr.splice(where === 'before' ? to : to + 1, 0, this);
      },
      merge() {
        const arr = doc.layers;
        const index = arr.indexOf(this);
        const below = arr[index + 1];
        arr.splice(index, 1);
        if (!below) return;
        doc.activeLayer = below;
        // 'lost'：PS 报告合并成功，但像素没真的并进去——正是真机上的实际故障。
        if (mergeBehaviour === 'lost') return;
        const left = Math.min(this.content.left, below.content.left);
        const top = Math.min(this.content.top, below.content.top);
        const right = Math.max(this.content.left + this.content.width, below.content.left + below.content.width);
        const bottom = Math.max(this.content.top + this.content.height, below.content.top + below.content.height);
        below.content = { left, top, width: right - left, height: bottom - top };
      }
    };
  }

  function makeDoc() {
    return { id: nextId++, typename: 'Document', layers: [], activeLayer: null };
  }

  return { context, makeLayer, makeDoc, Studio: context.Studio };
}

// 场景：画布 2618×2560，照片占左侧 2048，结果图只有右侧 2047..2618 有像素。
function expandScene(options) {
  const opts = options || {};
  // 双向扩图（右+下）时画布更高，而且新图层的包围盒天然等于整幅画布——这条路径
  // 以前会被误判成「模型画了整张画面」，所以单独做一个场景。
  const twoSided = !!opts.twoSided;
  const frameW = 2618;
  const frameH = twoSided ? 3142 : 2560;
  const fake = fakeBridge(options);
  const target = fake.makeDoc();
  const photo = fake.makeLayer(target, { left: 0, top: 0, width: 2048, height: 2560 });
  target.layers.push(photo);
  target.activeLayer = photo;
  const result = fake.makeDoc();
  const stripLeft = (twoSided || (options && options.resultFullFrame)) ? 0 : 2047;
  const stripWidth = twoSided ? frameW : (options && options.resultFullFrame ? 2618 : 571);
  const stripHeight = twoSided ? frameH : 2560;
  const source = fake.makeLayer(result, { left: stripLeft, top: 0, width: stripWidth, height: stripHeight });
  result.layers.push(source);
  result.activeLayer = source;
  result.width = { as: () => frameW };
  result.height = { as: () => frameH };
  fake.context.app.activeDocument = target;
  const snapshot = {
    width: frameW,
    height: frameH,
    layerBounds: { left: 0, top: 0, right: 2048, bottom: 2560 },
    activeLayerId: photo.id
  };
  const out = fake.Studio.applyExpand(target, result, snapshot, { width: frameW, height: frameH }, null);
  // 失败原因走的是 Studio.trimReason 这个「全局诊断字段」，由 apply 一起带回面板，
  // 所以测试也读它，而不是读 applyExpand 的返回值。
  out.trimReason = fake.Studio.trimReason;
  return { fake, target, photo, source, out, snapshot };
}

test('stripUnion covers every expanded side', () => {
  const Studio = bridge();
  const union = Studio.stripUnion([
    { left: 0, top: 0, right: 100, bottom: 800 },
    { left: 700, top: 0, right: 800, bottom: 800 },
    { left: 100, top: 760, right: 700, bottom: 800 }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(union)), { left: 0, top: 0, right: 800, bottom: 800 });
});

test('an expand result lands on its own layer, aligned, with the photo untouched', () => {
  // PS 把图层搬进另一个文档时，落点由它自己决定（实测会居中）。旧代码按绝对坐标平移，
  // 整块被推到画布外，扩图区一片透明，却仍然报告「已合并」。
  // 现在扩图一律独立成层：位置仍然要对，但原图层一个像素都不动。
  const { target, photo, out } = expandScene({ placement: { x: 300, y: 120 } });
  assert.equal(out.separate, true);
  assert.equal(out.merged, false, '扩图不再合并回原图层');
  assert.equal(target.layers.length, 2, '结果单独一层，原图层还在');
  assert.equal(photo.content.left, 0);
  assert.equal(photo.content.width, 2048, '原图层必须保持原样');
  assert.equal(out.layer.content.left, 2047, '新图层要摆回扩图区的位置');
  assert.equal(out.layer.content.width, 571);
  assert.equal(out.layer.name, 'AI 图像工坊 扩图');
});

test('a layer that cannot be moved into place is kept separate and flagged, not merged blindly', () => {
  // 平移不生效（锁定图层、或 PS 不认这次 translate）时，条带会停在错的位置。
  // 这时必须先把位置判出来、在名字和原因里说清楚，而不是让用户以为扩图成功了。
  const { target, out } = expandScene({ placement: { x: 300, y: 120 }, translate: false });
  assert.equal(out.merged, false);
  assert.match(out.trimReason, /^align/);
  assert.equal(target.layers.length, 2, '对不齐时结果要留在新图层上，不能丢');
  assert.match(out.layer.name, /未对齐/);
});

test('a full-frame result is kept as its own layer so it cannot overwrite the photo', () => {
  const { target, photo, out } = expandScene({ resultFullFrame: true });
  assert.equal(out.merged, false);
  assert.match(out.trimReason, /full-result/);
  assert.equal(target.layers.length, 2);
  assert.equal(photo.content.width, 2048, '原图层不能被整图覆盖');
  assert.match(out.layer.name, /整张画面/, '名字要能看出这是整图重绘');
});

// 右+下一起扩：新增区是 L 形，包围盒必然等于整幅画布（右边条带横跨全长、
// 下边条带铺满全宽）。用包围盒判「整张画面」会 100% 误报，用户看到的就是
// 「模型重写了整张画面，不只是边缘」——而实际图层里只有新增区有像素。
test('extending two sides at once is not reported as a full-frame repaint', () => {
  const { photo, out } = expandScene({ twoSided: true });
  assert.equal(out.separate, true);
  assert.equal(out.trimReason, '', 'L 形新增区不能判成整图重绘');
  assert.equal(out.layer.name, 'AI 图像工坊 扩图', '名字里不该出现「整张画面」');
  assert.equal(photo.content.width, 2048, '原图层一个像素都不动');
});

test('a genuinely full-frame result in a two-sided canvas is still kept apart', () => {
  // 万一渠道真的回了整幅不透明的图，这条兜底也不能丢：它至少是独立图层，
  // 用户能一眼看出照片被盖住并删掉；只是不再谎报「模型重绘」。
  const { target, photo, out } = expandScene({ twoSided: true });
  assert.equal(target.layers.length, 2);
  assert.equal(out.layer.content.left, 0);
  assert.equal(photo.content.width, 2048);
});

// 11 月 13 日的现场：活动层停在底部那条 285 高的透明带上。
// 比例来自画布透明边（scalesDerived），反解出的矩形是 {0,0,2048,2560}；
// 而图层范围是 {0,2559,2048,2844}——一个只落在画面底部的条带。
// 旧逻辑无条件信图层范围，于是「新增区」被算成那条带子，结果贴到了画布外面：
// 面板说「已合并」，画布上却什么都看不见。
test('resolveInner ignores a layer bounds that is just the transparent strip', () => {
  const snapshot = {
    width: 2048, height: 2844,
    layerBounds: { left: 0, top: 2559, right: 2048, bottom: 2844 },
    scales: { top: 1, right: 1, bottom: 1.111, left: 1 },
    scalesDerived: true
  };
  const inner = bridge().resolveInner(snapshot, { width: 2048, height: 2844 }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(inner)), { left: 0, top: 0, right: 2048, bottom: 2560 });
});

test('resolveInner still prefers the layer bounds when both agree', () => {
  // 两者一致（差 6px 以内）时用 Photoshop 的：它不受半透明描边影响，更准。
  const snapshot = {
    width: 2048, height: 2560,
    layerBounds: { left: 0, top: 0, right: 2042, bottom: 2560 },
    scales: { top: 1, right: 1, bottom: 1.111, left: 1 },
    scalesDerived: true
  };
  const inner = bridge().resolveInner(snapshot, { width: 2048, height: 2844 }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(inner)), { left: 0, top: 0, right: 2042, bottom: 2560 });
});
