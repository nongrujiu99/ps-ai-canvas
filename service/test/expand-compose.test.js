'use strict';

// 扩图合成：把「只有新增条带」的结果贴回画布。这里守两条底线——
// 条带必须只有新增区有像素（CEP 侧靠它判断裁切是否成功），
// 以及接缝不能是硬切（那是用户一眼就看出「拼上去的」的原因）。

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { composeExpand, expandStrips, extensionFidelity, detailEnergy, saneBounds, photoLikeBounds, deriveScales } = require('../src/expand-compose');

const solid = (w, h, r, g, b, alpha = 255) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha } } }).png().toBuffer();

async function raw(bytes) {
  return sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

const at = (img, x, y, c) => img.data[(y * img.info.width + x) * img.info.channels + c];

// 一块画布：左侧照片（暗）、右侧新增区（亮）。模型「画」出来的条带比原图亮 100 级，
// 这正是中转站降档生成时的典型偏差。
async function scene({ direction = 'right' } = {}) {
  const W = 400;
  const H = 300;
  const frame = { width: W, height: H };
  const bounds = { left: 0, top: 0, right: 300, bottom: 300 };
  if (direction === 'bottom') {
    bounds.left = 0; bounds.right = 400; bounds.top = 0; bounds.bottom = 200;
  }
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(bounds.right - bounds.left, bounds.bottom - bounds.top, 100, 100, 100), left: bounds.left, top: bounds.top }])
    .png().toBuffer();
  const model = await solid(W, H, 200, 200, 200);
  const strips = expandStrips(W, H, bounds);
  return { W, H, frame, bounds, base, model, strips };
}

test('只有新增条带有像素，照片区保持全透明', async () => {
  const s = await scene();
  const out = await raw(await composeExpand(s.model, { window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame }));
  assert.equal(at(out, 100, 150, 3), 0, '照片区必须透明，否则会盖掉原图');
  assert.equal(at(out, 350, 150, 3), 255, '新增区必须有像素');
});

test('接缝处用原图那一列的颜色收口，不再是一条硬直线', async () => {
  const s = await scene();
  const out = await raw(await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: s.base
  }));
  // 接缝第一列（画布 x=299）应当贴近原图的 100，而不是生成块的 200。
  assert.ok(Math.abs(at(out, 299, 150, 0) - 100) <= 4, '接缝第一列应等于原图边缘色，实际 ' + at(out, 299, 150, 0));
  // 往里逐步过渡到生成色（生成块 200，整体色偏被压低后约 182）。
  const seam = at(out, 299, 150, 0);
  const near = at(out, 305, 150, 0);
  const far = at(out, 395, 150, 0);
  assert.ok(near > seam, '应当从原图色过渡到生成色：' + [seam, near, far].join(' → '));
  // 模型整块亮 100 级属于系统性色偏：harmonize 先整块拉 24 级（封顶），
  // 二维补偿再把条带拽向照片色调。上限随深度放宽（近处 26、深处 130），
  // 所以补偿量越往里越大，形状不再是单调递增的——这里只认最终落在照片色附近。
  assert.ok(far <= 130 && far >= 100, '远离接缝处应被整块拉向照片色调，实际 ' + far);
});

test('接缝柔化不能用降低 alpha 的方式做', async () => {
  // 扩展区外侧在画布上是空的。降 alpha 只会露出画布底色，接缝变成一条白带，
  // 比硬线更难看——所以这里盯死「全程不透明」。
  const s = await scene();
  const out = await raw(await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: s.base
  }));
  for (let x = 299; x < 400; x += 7) {
    assert.equal(at(out, x, 150, 3), 255, 'x=' + x + ' 处出现了半透明');
  }
});

test('没有 bounds 时不改像素，老调用方行为不变', async () => {
  const s = await scene();
  const plain = await raw(await composeExpand(s.model, { window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame }));
  assert.equal(at(plain, 299, 150, 0), 200, '不给 bounds 时应当原样贴上去');
});

test('下侧扩图同样沿接缝收口', async () => {
  const s = await scene({ direction: 'bottom' });
  const out = await raw(await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: s.base
  }));
  // 接缝在 y=199（条带从 bounds.bottom-1 开始）
  assert.ok(Math.abs(at(out, 200, 199, 0) - 100) <= 4, '下侧接缝第一行应等于原图边缘色，实际 ' + at(out, 200, 199, 0));
  assert.equal(at(out, 200, 100, 3), 0, '照片区保持透明');
});

// 色延展依赖「能从底图上取到接缝那一列」。取不到时它什么都不做，成品上留一条硬边，
// 而且以前是彻底静默的——用户放大 300% 才看得见，日志里全绿。
test('色延展取不到边缘色时，兜底自检也会把接缝拉平', async () => {
  const s = await scene();
  // 底图照片只到 x=295，接缝（x=299）那一列落在透明区：edgeColorAt 全部返回 null，
  // 色延展退化成「起点=生成色」，等于什么都没做。
  const shortBase = await sharp({ create: { width: s.W, height: s.H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(296, 300, 100, 100, 100), left: 0, top: 0 }]).png().toBuffer();
  const out = await raw(await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: shortBase
  }));
  const seam = at(out, 299, 150, 0);
  const far = at(out, 395, 150, 0);
  assert.ok(seam < 190, '接缝处应被拉向原图边缘色（100），实际 ' + seam);
  assert.ok(far >= 195, '远离接缝处不该被整块改色，实际 ' + far);
  assert.equal(at(out, 150, 150, 3), 0, '照片区保持透明');
});

test('色差补偿有上限，内容本来不同时不会把边缘压出暗带', async () => {
  // 原图边缘极暗（10）、生成块极亮（250）：无上限的话接缝会被拉成一条黑洞。
  const s = await scene();
  const darkBase = await sharp({ create: { width: s.W, height: s.H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(300, 300, 10, 10, 10), left: 0, top: 0 }]).png().toBuffer();
  const out = await raw(await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: darkBase
  }));
  const near = at(out, 310, 150, 0);
  // 补偿上限随深度放宽（近处 26、深处 130），且到上限后饱和。
  // 这里原图边几乎是纯黑（10）、模型整块 250 级亮，属于「内容本来就不同」的极端；
  // 上限保证它不会被一路压向 10（那会在接缝旁压出一道黑洞），
  // 但也不会停在模型原色——实测落在 105~120，比照片暗、比模型原色明显靠近。
  assert.ok(near >= 105, '补偿被上限挡住，接缝附近不应压出暗带，实际 ' + near);
});

// 11 月 13 日真实扩图：接缝实测差 22.2 灰阶，旧逻辑只补了 160px，285px 条带的
// 下面 120px 原样留着模型自己的色调——用户一眼看出「下半截色差」。
test('模型的系统性色偏整块拉回，而不是只修接缝那一圈', async () => {
  const s = await scene();
  // 照片 100、模型 150：色偏 50 级，超过 ±24 的单步上限，会分两步被拉回：
  // harmonize 整块拉 24 级，色延展在接缝带里再补残差。
  const model = await solid(s.W, s.H, 150, 150, 150);
  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: s.base
  }));
  const far = at(out, 395, 150, 0);
  assert.ok(far <= 135, '条带深处应被整块拉向照片色调（100），实际 ' + far);
  assert.ok(far >= 100, '不能拉过头压过照片本身的色调，实际 ' + far);
});

test('个别列内容不同不会带偏整体色偏对齐', async () => {
  // 模型在条带里画了几条与照片无关的暗带（内容对不上是常态，不是异常）。
  // 逐列差取均值会被这些列带偏；中位数只认占多数的系统性偏差。
  const s = await scene();
  const band = await solid(s.W, 8, 20, 20, 20);
  const model = await sharp({ create: { width: s.W, height: s.H, channels: 4, background: { r: 150, g: 150, b: 150, alpha: 255 } } })
    .composite([
      { input: band, left: 299, top: 10 },
      { input: band, left: 299, top: 140 },
      { input: band, left: 299, top: 270 }
    ]).png().toBuffer();
  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: s.frame, bounds: s.bounds, base: s.base
  }));
  const far = at(out, 395, 60, 0);
  assert.ok(far <= 135 && far >= 100, '暗带不该把整块对齐带偏：' + far);
});

// 扩图最容易「一切正常但结果不对」的一种：模型把上传的模糊底稿原样交回来，
// 一个像素都没重绘。请求 200、合成成功、落位成功，用户在 PS 里看到的却是一块白雾。
// 这里锁住判定本身——它不需要人眼看图就能分辨「画了」和「没画」。

// 底稿的扩展区必须自带起伏，否则「回来的图和底稿一样」证明不了什么
// （原图边缘本来就是一块平墙时，模型可能真的画了同色的墙）。
async function textured(w, h) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = 60 + ((x * 7 + y * 3) % 120);
      data[i] = v; data[i + 1] = 120; data[i + 2] = 140;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

const CANVAS = { width: 400, height: 300 };
const BOUNDS = { left: 0, top: 0, right: 300, bottom: 300 };
const STRIPS = expandStrips(CANVAS.width, CANVAS.height, BOUNDS);

test('扩展区与底稿几乎一致时判定为「没重绘」', async () => {
  const prefill = await textured(CANVAS.width, CANVAS.height);
  const verdict = await extensionFidelity(prefill, prefill, STRIPS, CANVAS);
  assert.equal(verdict.checked, true);
  assert.equal(verdict.stale, true, '原样返回必须被识别出来');
  assert.equal(verdict.blank, false);
});

test('扩展区被画成一片白也算失败', async () => {
  const prefill = await textured(CANVAS.width, CANVAS.height);
  const white = await solid(CANVAS.width, CANVAS.height, 255, 255, 255);
  const verdict = await extensionFidelity(white, prefill, STRIPS, CANVAS);
  assert.equal(verdict.stale, false);
  assert.equal(verdict.blank, true, '整块纯白要拦住');
});

test('真的画了内容就不该误判', async () => {
  const prefill = await textured(CANVAS.width, CANVAS.height);
  const painted = await textured(CANVAS.width, CANVAS.height);
  const shifted = await sharp(painted).modulate({ brightness: 1.6 }).png().toBuffer();
  const verdict = await extensionFidelity(shifted, prefill, STRIPS, CANVAS);
  assert.equal(verdict.stale, false);
  assert.equal(verdict.blank, false);
});

test('底稿本身就是一块纯色时不硬判「没重绘」', async () => {
  // 原图边缘是一面平墙，底稿没有起伏，「回来的图也差不多」说明不了模型没画。
  const prefill = await solid(CANVAS.width, CANVAS.height, 200, 200, 200);
  const verdict = await extensionFidelity(prefill, prefill, STRIPS, CANVAS);
  assert.equal(verdict.checked, true);
  assert.equal(verdict.stale, false);
});

// 第三种失败：画了，也有颜色，但整块没有细节——「糊成一片」。
// 它既不是原样返回（和底稿差得远），也不是一片白，前两个判据都放它过去。
test('扩展区只有平滑色带时判定为「没细节」', async () => {
  const prefill = await textured(CANVAS.width, CANVAS.height);
  // 一块只有大尺度渐变的图：颜色和底稿不同，但完全没有起伏
  const smooth = await sharp({
    create: { width: CANVAS.width, height: CANVAS.height, channels: 3, background: '#8899aa' }
  }).png().toBuffer();
  const verdict = await extensionFidelity(smooth, prefill, STRIPS, CANVAS, BOUNDS);
  assert.equal(verdict.checked, true);
  assert.equal(verdict.stale, false);
  assert.equal(verdict.blank, false);
  assert.equal(verdict.flat, true, '没有细节的色带要拦住');
  assert.ok(verdict.extDetail < verdict.photoDetail);
});

test('真的有细节时不会误判成糊', async () => {
  const prefill = await textured(CANVAS.width, CANVAS.height);
  const painted = await textured(CANVAS.width, CANVAS.height);
  const shifted = await sharp(painted).modulate({ brightness: 1.4 }).png().toBuffer();
  const verdict = await extensionFidelity(shifted, prefill, STRIPS, CANVAS, BOUNDS);
  assert.equal(verdict.flat, false);
});

// ── 景深对齐 ───────────────────────────────────────────────────────────
// 真实翻车：原图是浅景深虚化的室内照，右侧扩展区却给出了边缘锐利的架子和地板。
// 内容就算接得上，眼睛也会立刻判断「这是拼的」。合成层必须把延伸区压回同一景深。

async function softScene({ bandSigma, blur }) {
  const W = 400;
  const H = 300;
  const photo = await sharp({ create: { width: 300, height: 300, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 26 } } })
    .blur(blur).png().toBuffer();
  const band = await sharp({ create: { width: 100, height: 300, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: bandSigma } } })
    .png().toBuffer();
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: photo, left: 0, top: 0 }]).png().toBuffer();
  const model = await sharp({ create: { width: W, height: H, channels: 3, background: '#787878' } })
    .composite([{ input: band, left: 300, top: 0 }]).png().toBuffer();
  const bounds = { left: 0, top: 0, right: 300, bottom: 300 };
  return { W, H, base, model, bounds, strips: expandStrips(W, H, bounds) };
}

test('延伸区比原图清楚太多时会被压到同一景深', async () => {
  const s = await softScene({ bandSigma: 70, blur: 1.5 });
  const out = await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: { width: s.W, height: s.H }, bounds: s.bounds, base: s.base
  });
  const photoRaw = await raw(await sharp(s.base).removeAlpha().png().toBuffer());
  const outRaw = await raw(await sharp(out).removeAlpha().png().toBuffer());
  const photoDetail = detailEnergy(photoRaw, 60, 240, 60, 240);
  // 取条带靠里那一段，避开接缝的色延展
  const extDetail = detailEnergy(outRaw, 350, 396, 40, 260);
  assert.ok(extDetail < photoDetail * 1.9, '延伸区应当被压到接近原图景深：' + extDetail.toFixed(2) + ' vs ' + photoDetail.toFixed(2));
});

test('延伸区本来就比原图糊时不做处理', async () => {
  // 只做单向：模糊不能凭空生出细节，硬提只会出噪点。
  const s = await softScene({ bandSigma: 4, blur: 6 });
  const out = await composeExpand(s.model, {
    window: { left: 0, top: 0, right: s.W, bottom: s.H }, strips: s.strips, frame: { width: s.W, height: s.H }, bounds: s.bounds, base: s.base
  });
  const outRaw = await raw(await sharp(out).removeAlpha().png().toBuffer());
  const extDetail = detailEnergy(outRaw, 350, 396, 40, 260);
  // 平滑的条带经过接缝色延时仍然是平滑的，不该被"锐化"出细节
  assert.ok(extDetail < 3, '糊的延伸区不该被动过，实际 ' + extDetail.toFixed(2));
});

// ── 整张重画 ───────────────────────────────────────────────────────────
// 这是这一轮「内容还是接不上」的直接证据：mask 只标了右侧条带，模型却把整张画面
// 重新画了一遍——它画的延伸区就成了自己重新构图的结果，跟原图对不上是必然的。
test('模型重画了照片本体时判定为 alien', async () => {
  const prefill = await textured(400, 300);
  // 只有条带被改：正常
  const ok = await extensionFidelity(prefill, prefill, STRIPS, CANVAS, BOUNDS);
  assert.equal(ok.alien, false);
  assert.ok(ok.photoDrift < 2);
  // 整张被换成一幅完全不同的画面：必须报出来
  const repainted = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c89060' } }).png().toBuffer();
  const bad = await extensionFidelity(repainted, prefill, STRIPS, CANVAS, BOUNDS);
  assert.equal(bad.alien, true, '照片区被重画必须判出来');
  assert.ok(bad.photoDrift > 40);
});

// ── 评分 ───────────────────────────────────────────────────────────────
// 四种毛病要能互相比较，才能在一轮里的几次尝试之间挑一个交差。
// 规则只有一条是硬的：100 表示「什么都没画」，这种结果没有价值，只能报错；
// 其余都要小于 100，意味着一张有内容、但某方面不够好的图，该交给用户判断，
// 而不是连着一次真实的生成一起扔掉。
test('评分把「什么都没画」和「画了但不理想」分开', async () => {
  const prefill = await textured(400, 300);

  // 只有延伸区被重画（照片区原样）：挑不出毛病的基准
  const painted = await sharp(prefill).composite([{
    input: await sharp(prefill).extract({ left: 300, top: 0, width: 100, height: 300 }).modulate({ brightness: 1.5 }).toBuffer(),
    left: 300,
    top: 0
  }]).png().toBuffer();
  const clean = await extensionFidelity(painted, prefill, STRIPS, CANVAS, BOUNDS);
  assert.equal(clean.severity, 0, '挑不出毛病就该是 0');

  const echo = await extensionFidelity(prefill, prefill, STRIPS, CANVAS, BOUNDS);
  assert.equal(echo.stale, true);
  assert.equal(echo.severity, 100, '原样交回没有任何价值，只能报错');

  const white = await extensionFidelity(
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer(),
    prefill, STRIPS, CANVAS, BOUNDS
  );
  assert.equal(white.blank, true);
  assert.equal(white.severity, 100);

  const alienVerdict = await extensionFidelity(
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c89060' } }).png().toBuffer(),
    prefill, STRIPS, CANVAS, BOUNDS
  );
  assert.equal(alienVerdict.alien, true);
  assert.ok(alienVerdict.severity > 0 && alienVerdict.severity < 100, '整张重画要能出图，只是分数差');
});

test('bare 形态（模型必然重画整幅）不把照片区漂移算成毛病', async () => {
  const prefill = await textured(400, 300);
  const repainted = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c89060' } }).png().toBuffer();
  const normal = await extensionFidelity(repainted, prefill, STRIPS, CANVAS, BOUNDS);
  const bare = await extensionFidelity(repainted, prefill, STRIPS, CANVAS, BOUNDS, { regenerated: true });
  assert.equal(normal.alien, true);
  assert.equal(bare.alien, false, '这种问法下照片本来就会被重画，不是「接不上」的证据');
  assert.ok(bare.severity < normal.severity);
});

// ── 扩图比例的推导基础 ────────────────────────────────────────────────────
// 11 月 13 日的现场：2048×2844 的画布，活动层停在底部那条 285 高的透明带上。
// 这个范围语法上完全合法（在画布内、尺寸够、确实有新增区），但它是画面的一角，
// 不是照片。拿它当原图，上方 2559px 会被算成 9.98 倍，被上限挡回，面板只好退回
// 一个手填的默认值——用户看到的「右 1.5」就是这么来的。
test('a layer bounds that misses the opaque area is not the photo', () => {
  const canvas = { width: 2048, height: 2844 };
  const opaque = { left: 0, top: 0, right: 2048, bottom: 2560 };
  const strip = { left: 0, top: 2559, right: 2048, bottom: 2844 };
  assert.equal(saneBounds(strip, canvas) !== null, true, '这个范围本身能过基本的合理性检查');
  assert.equal(photoLikeBounds(strip, opaque), null, '但它盖不住画面，所以不是原照片');
  // 真的照片范围当然要认。
  assert.deepEqual(photoLikeBounds(opaque, opaque), opaque);
});

test('scales come from whichever candidate range makes sense', () => {
  const canvas = { width: 2048, height: 2844 };
  const opaque = { left: 0, top: 0, right: 2048, bottom: 2560 };
  // 285 高的条带：上方 2559px 要算成 9.98 倍，超出 1~2 的范围 → 推不出来
  assert.equal(deriveScales({ left: 0, top: 2559, right: 2048, bottom: 2844 }, canvas), null);
  // 真实范围：只有下方需要扩，284/2560 = 1.111
  const scales = deriveScales(opaque, canvas);
  assert.equal(Number(scales.bottom.toFixed(3)), 1.111);
  assert.equal(scales.top, 1);
  assert.equal(scales.left, 1);
  assert.equal(scales.right, 1);
  // 一点都没扩（等于画布）也不算可用的推导结果：那说明没有透明边。
  assert.equal(deriveScales(canvas, canvas), null);
});

// ── 接缝带不能把纹理抹平 ──────────────────────────────────────────────────
// 羽化带是靠「贴合原图边缘那一列的颜色、再渐入生成色」做出来的。这一步天然会
// 压低纹理：d=0 时整行等于原图最后一行，d 小的时候行内标准差被线性摊薄。
// 羽化带只要不超过条带自身厚度的一小截，这条带就看不见；超了，用户看到的就是
// 「贴边一条发虚的横带」——他会把它描述成色差。
test('窄条带的羽化带不能吃掉条带的一大截', async () => {
  const W = 2400;
  const H = 1170;
  const photoBottom = 1110; // 条带只有 60px 高
  const frame = { width: W, height: H };
  const bounds = { left: 0, top: 0, right: W, bottom: photoBottom };

  // 照片是平的（拍平墙），条带是竖条纹：行内标准差先高后低一眼能看出来。
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(W, photoBottom, 128, 128, 128), left: 0, top: 0 }]).png().toBuffer();
  const stripeData = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x % 2 === 0 ? 60 : 196; // 均值 128、标准差 68
      const i = (y * W + x) * 3;
      stripeData[i] = v; stripeData[i + 1] = v; stripeData[i + 2] = v;
    }
  }
  const model = await sharp(stripeData, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();

  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: W, bottom: H },
    strips: expandStrips(W, H, bounds), frame, bounds, base
  }));

  const rowStd = (y) => {
    const v = [];
    for (let x = 4; x < W - 4; x++) v.push(at(out, x, y, 0));
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  };
  const full = rowStd(photoBottom + 58); // 条带底部，羽化带够不着
  assert.ok(full > 55, '基准：条纹本身该有 68 左右的标准差，实际 ' + full);

  let flattened = 0;
  for (let d = 0; d < 60; d++) if (rowStd(photoBottom + d) < full * 0.7) flattened++;
  assert.ok(flattened <= 8, '被抹平的只有贴边几像素，实际 ' + flattened + 'px（条带总高 60px）');
});

// ── 条带比原图虚时要往回补 ────────────────────────────────────────────────
// 模型经常把延伸区按低一档分辨率生成再放大回来：颜色对、细节没了。
// 以前 matchDepth 只会「太清楚就压虚」，不虚不锐；结果接缝下面一块糊。
test('条带比原图虚时会补锐度，而且不会补过头', async () => {
  const W = 400;
  const H = 300;
  const frame = { width: W, height: H };
  const bounds = { left: 0, top: 0, right: 300, bottom: 300 };
  const tex = await textured(W, H);
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: tex, left: 0, top: 0 }]).png().toBuffer();
  // 模型交回来的是一张明显更虚的图（sigma 2 的糊）
  const model = await sharp(tex).blur(2).png().toBuffer();

  const photoRaw = await raw(base);
  const photoDetail = detailEnergy(photoRaw, 0, 300, 0, 300);
  const modelRaw = await raw(model);
  const beforeRatio = detailEnergy(modelRaw, 320, 396, 4, 296) / photoDetail;

  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: W, bottom: H },
    strips: expandStrips(W, H, bounds), frame, bounds, base
  }));
  const stripDetail = detailEnergy(out, 320, 396, 4, 296);
  const ratio = stripDetail / photoDetail;

  // 补锐只能把「被放大糊掉」的细节找回来一部分，找不回全部——比的是它确实动了手，
  // 而且没有锐化成描边。
  assert.ok(ratio >= beforeRatio * 1.2, '虚条带应当被补回一些细节：' + beforeRatio.toFixed(2) + ' → ' + ratio.toFixed(2));
  assert.ok(ratio <= 1.25, '不能补过头（锐化边缘会比原图更假），实际比值 ' + ratio.toFixed(2));
});

// ── 色偏补偿的统计口径与形状 ─────────────────────────────────────────────
//
// 下面两条守的是 11-14 用户截图里真正看到的两个现象：
// 「接缝接上了，但右边整块还是偏亮」，以及「补偿反而把近处压暗」。

test('条带比照片高时，照片侧只统计有像素的那段，补偿不会被拉成正数', async () => {
  // 画布 400×400、照片只有 300×200：右侧条带的下半截在底图上是透明的。
  // 如果照片侧把透明行也算进均值（读到 0），均值会被拉低，delta 变成正数——
  // 本该压暗的补偿变成提亮，越修越亮。
  const W = 400;
  const H = 400;
  const bounds = { left: 0, top: 0, right: 300, bottom: 200 };
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(300, 200, 100, 100, 100), left: 0, top: 0 }])
    .png().toBuffer();
  const model = await solid(W, H, 130, 130, 130);
  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: W, bottom: H },
    strips: expandStrips(W, H, bounds), frame: { width: W, height: H }, bounds, base
  }));
  // 模型 130 比照片 100 亮 30，补偿方向必须向下；方向反了会比 130 更亮。
  const seam = at(out, 302, 100, 0);
  assert.ok(seam <= 132, '补偿方向反了：接缝处 ' + seam + '，比模型原色 130 还亮');
});

test('模型偏差随深度变大时，补偿跟着变大，不近处过补、深处欠补', async () => {
  // 照片纯 100；条带从接缝处 +2 涨到深处 +26——真实模型就是这样（近处还能对上，
  // 越往里越放飞）。单值 delta 只能选一个深度对齐：近处过补压出暗带，或深处留下亮块。
  const W = 400;
  const H = 300;
  const bounds = { left: 0, top: 0, right: 300, bottom: 300 };
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(300, 300, 100, 100, 100), left: 0, top: 0 }])
    .png().toBuffer();
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x < 300 ? 100 : Math.round(100 + 2 + 24 * (1 - Math.exp(-(x - 299) / 40)));
      const i = (y * W + x) * 3;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
    }
  }
  const model = await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: W, bottom: H },
    strips: expandStrips(W, H, bounds), frame: { width: W, height: H }, bounds, base
  }));
  const near = at(out, 320, 150, 0) - 100;
  const far = at(out, 392, 150, 0) - 100;
  assert.ok(Math.abs(near) <= 8, '近处残差过大（过补会压出暗带）：' + near);
  assert.ok(Math.abs(far) <= 8, '深处残差过大（欠补会留亮块）：' + far);
});

// 11 月 14 日晚：2600×2560 的扩图（照片 2048×2560、右侧扩 552px），
// 照片右边缘自上而下从亮墙（L 209）走到暗书架（L 45）、再回到皮肤，
// 而模型生成的那条墙是均匀的。一维曲线只能取一个全局中位去补，
// 于是同一张图上「亮处补不够（右边整块发白）、暗处补过头（压出暗带）」，
// 逐段残差实测从 -78 到 +128 都有。这条守的就是「按接缝方向分段各补各的」。
test('偏差沿接缝方向不同时，补偿逐段生效，不是全条带共用一个数', async () => {
  const W = 400;
  const H = 600;
  const bounds = { left: 0, top: 0, right: 300, bottom: H };
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await solid(300, 300, 180, 180, 180), left: 0, top: 0 },
      { input: await solid(300, 300, 80, 80, 80), left: 0, top: 300 }
    ]).png().toBuffer();
  // 模型把整条带画成均匀的 150：对上半段偏暗 30，对下半段偏亮 70。
  const model = await solid(W, H, 150, 150, 150);
  const out = await raw(await composeExpand(model, {
    window: { left: 0, top: 0, right: W, bottom: H }, strips: expandStrips(W, H, bounds), frame: { width: W, height: H }, bounds, base
  }));
  const top = at(out, 380, 90, 0);
  const bottom = at(out, 380, 520, 0);
  assert.ok(Math.abs(top - 180) <= 15, '上段照片边是 180，应补到 180 附近，实际 ' + top);
  assert.ok(Math.abs(bottom - 80) <= 15, '下段照片边是 80，应补到 80 附近，实际 ' + bottom);
});
