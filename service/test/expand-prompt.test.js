'use strict';

// 扩图提示词。这里守的不是文案漂亮，而是三件会直接决定出图对不对的事：
// 1) 用户写的「画面描述」必须在最前面（模型对开头最敏感）；
// 2) 即使用户什么都不写，也必须带上「画出结构/内容、禁止涂成一片白」的硬约束；
// 3) 方向和比例要量化写进去，否则模型常常只补一条几像素的过渡带。

const test = require('node:test');
const assert = require('node:assert');
const { buildExpandPrompt, extentSentence } = require('../src/expand-prompt');

const canvas = { width: 2618, height: 2560 };
const bounds = { left: 0, top: 0, right: 2048, bottom: 2560 };

test('用户的画面描述排在最前面，但要框成「延续成什么样」', () => {
  const prompt = buildExpandPrompt('右边接着白墙和木架', { bounds, canvas });
  // 裸放用户原文会被模型当成「要新画进去的清单」——上一版就是这么在右边
  // 画出一个全新木架加一盆植物的。必须带一个「延续成」的框。
  assert.ok(prompt.startsWith('延伸区需要延续成：右边接着白墙和木架'), '用户描述必须打头');
});

test('不写画面描述时也要带齐「画内容」的约束', () => {
  const prompt = buildExpandPrompt('', { bounds, canvas });
  assert.match(prompt, /扩图任务/);
  // 第一优先级是「观感一致」：模型画得再丰富，只要比原图清楚就不像同一张照片。
  assert.match(prompt, /景深/, '必须先讲景深');
  assert.match(prompt, /清晰度必须一致/);
  assert.match(prompt, /色温、白平衡、亮度/);
  // 第二优先级才是「别乱加东西」：上一版就是在这里翻的车——
  // 原图边缘只有半截架子横板，模型补了一整套家具出来。
  assert.match(prompt, /不要在延伸区新增或补全任何物体/);
  assert.match(prompt, /严禁把延伸区涂成一片纯色/);
  assert.match(prompt, /白雾/);
});

test('三种重试各自点名一种失败方式', () => {
  const empty = buildExpandPrompt('延伸', { bounds, canvas, attempt: 2, reason: 'empty' });
  const flat = buildExpandPrompt('延伸', { bounds, canvas, attempt: 2, reason: 'flat' });
  const alien = buildExpandPrompt('延伸', { bounds, canvas, attempt: 2, reason: 'alien' });
  assert.match(empty, /一片空白或均匀模糊/);
  assert.match(flat, /模糊色带/);
  assert.match(alien, /画了原图里没有的东西/);
  assert.notEqual(empty, flat);
  assert.notEqual(flat, alien);
});

test('方向和幅度用数字说清楚', () => {
  // 2618 宽、照片 2048 宽 → 向右扩 570px，约占原图宽度 28%
  assert.match(extentSentence(bounds, canvas), /向右延展/);
  assert.match(extentSentence(bounds, canvas), /570 像素/);
  assert.match(extentSentence(bounds, canvas), /28%/);
});

test('多方向扩图会逐个列出来', () => {
  const text = extentSentence({ left: 120, top: 40, right: 2048, bottom: 2400 }, canvas);
  assert.match(text, /向上、向右、向下、向左/);
});

test('第二次尝试会点名上一版的失败方式', () => {
  const first = buildExpandPrompt('延伸', { bounds, canvas, attempt: 1 });
  const second = buildExpandPrompt('延伸', { bounds, canvas, attempt: 2 });
  assert.ok(!/上一版/.test(first));
  assert.match(second, /上一版/);
  assert.notEqual(first, second);
});

test('百炼那种「预填充底稿」模式用另一套说法', () => {
  const masked = buildExpandPrompt('延伸', { bounds, canvas, masked: true });
  const prefill = buildExpandPrompt('延伸', { bounds, canvas, masked: false });
  assert.match(masked, /遮罩标出的透明区域/);
  assert.match(prefill, /底稿里被拉伸、模糊、镜像糊掉的部分/);
});

test('三种请求形态说的是三件不同的事', () => {
  // 模型不听话时，换个问法比换形容词有效。这三种在模型眼里必须是三个任务：
  // 有遮罩的局部重绘 / 没有遮罩但保留留白底稿 / 只给原照片让它输出更大的构图。
  const masked = buildExpandPrompt('延伸', { bounds, canvas, shape: 'masked' });
  const padded = buildExpandPrompt('延伸', { bounds, canvas, shape: 'padded' });
  const bare = buildExpandPrompt('延伸', { bounds, canvas, shape: 'bare' });
  assert.match(masked, /遮罩标出的透明区域/);
  assert.match(padded, /底稿里被拉伸/);
  assert.match(bare, /输入是原照片本身/, 'bare 形态不能还说「底稿里糊掉的部分」');
  assert.notEqual(masked, padded);
  assert.notEqual(padded, bare);
});

test('bare 形态要说清原照片贴在输出画面的哪一角', () => {
  // 不交代位置，模型会把照片缩到画面中间、四周各补一圈——那样取出来的条带
  // 和画布坐标对不上，接缝必然错位。
  const prompt = buildExpandPrompt('延伸', { bounds, canvas, shape: 'bare' });
  assert.match(prompt, /原照片是 2048×2560/, '要给出输出画面与原照片的尺寸');
  assert.match(prompt, /贴在画面的左上角/);
  assert.match(prompt, /向右多出来的部分是延伸区/);
  // 竖扩时锚点在下面
  const down = buildExpandPrompt('延伸', {
    bounds: { left: 0, top: 0, right: 2618, bottom: 2048 },
    canvas, shape: 'bare'
  });
  assert.match(down, /向下多出来的部分是延伸区/);
});

test('没有几何信息时不硬凑方向和比例', () => {
  const prompt = buildExpandPrompt('延伸', {});
  assert.ok(!/像素（约为/.test(prompt));
  // 但硬约束一条都不能少
  assert.match(prompt, /严禁把延伸区涂成一片纯色/);
});

// 渠道会按提示词文本缓存安全判定：同一段文字被拦过一次就永远被拦。
// 所以每次请求带一个编号，让文本不重复——这条是实测出来的，不是洁癖。
test('带编号时提示词末尾多一个唯一标记，不带时完全不变', () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 1000 };
  const canvas = { width: 1200, height: 1000 };
  const plain = buildExpandPrompt('延伸', { bounds, canvas });
  const stamped = buildExpandPrompt('延伸', { bounds, canvas, stamp: 'k3f9x1' });

  assert.doesNotMatch(plain, /请求编号/);
  assert.match(stamped, /（请求编号 k3f9x1）$/);
  assert.equal(stamped.replace(' （请求编号 k3f9x1）', ''), plain, '编号只能是附加的，不能改动原有内容');
});
