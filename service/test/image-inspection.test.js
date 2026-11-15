const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { decodeCapture, inspectImage, prepareExpansion, buildExpandInput } = require('../src/image-inspection');

async function image(width, height, opaque) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 120;
      pixels[i + 1] = 140;
      pixels[i + 2] = 160;
      pixels[i + 3] = x >= opaque.left && x < opaque.right && y >= opaque.top && y < opaque.bottom ? 255 : 0;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function mask(width, height, selected) {
  const pixels = Buffer.alloc(width * height);
  for (let y = selected.top; y < selected.bottom; y++) {
    pixels.fill(255, y * width + selected.left, y * width + selected.right);
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

test('encoded and raw captures decode to the same opaque image and grayscale mask', async () => {
  const png = await image(600, 600, { left: 0, top: 0, right: 600, bottom: 600 });
  const gray = await mask(600, 600, { left: 10, top: 10, right: 30, bottom: 30 });
  const encoded = await decodeCapture({ kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }, { kind: 'encoded', dataUrl: 'data:image/png;base64,' + gray.toString('base64') });
  const raw = await decodeCapture({ kind: 'rgba', width: 600, height: 600, dataBase64: (await sharp(png).ensureAlpha().raw().toBuffer()).toString('base64') }, { kind: 'gray8', width: 600, height: 600, dataBase64: (await sharp(gray).greyscale().raw().toBuffer()).toString('base64') });
  assert.equal((await inspectImage(encoded.pngBytes, encoded.maskBytes)).selectionKind, 'inside');
  assert.equal((await inspectImage(raw.pngBytes, raw.maskBytes)).selectionKind, 'inside');
});

test('a selected rectangular transparent right edge is expansion', async () => {
  const png = await image(800, 600, { left: 0, top: 0, right: 600, bottom: 600 });
  const selected = await mask(800, 600, { left: 600, top: 0, right: 800, bottom: 600 });
  const info = await inspectImage(png, selected);
  assert.equal(info.selectionKind, 'transparentBorder');
  assert.deepEqual(info.opaqueBounds, { left: 0, top: 0, right: 600, bottom: 600 });
  const expansion = await prepareExpansion(png, selected);
  assert.equal((await sharp(expansion.originalPng).metadata()).width, 600);
  assert.equal(expansion.rightScale, 1 + 200 / 600);
  assert.equal(expansion.leftScale, 1);
});

test('a selection that crosses opaque pixels and transparent edge is ambiguous', async () => {
  const png = await image(800, 600, { left: 0, top: 0, right: 600, bottom: 600 });
  const selected = await mask(800, 600, { left: 590, top: 20, right: 700, bottom: 100 });
  assert.equal((await inspectImage(png, selected)).selectionKind, 'ambiguous');
});

test('an interior transparent hole is not mistaken for expansion', async () => {
  const png = await image(600, 600, { left: 0, top: 0, right: 600, bottom: 600 });
  const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
  pixels[(300 * 600 + 300) * 4 + 3] = 0;
  const holed = await sharp(pixels, { raw: { width: 600, height: 600, channels: 4 } }).png().toBuffer();
  const selected = await mask(600, 600, { left: 299, top: 299, right: 302, bottom: 302 });
  assert.equal((await inspectImage(holed, selected)).selectionKind, 'ambiguous');
});

test('model size and byte limits reject images before provider use', async () => {
  // 上限是 8192：扩图时「先把画布拉大」是标准用法，4200 多像素宽很常见，
  // 卡在 4096 会让用户收到一句看不懂的「宽高需在 512 到 4096」。
  const tooWide = await image(8193, 512, { left: 0, top: 0, right: 8193, bottom: 512 });
  await assert.rejects(inspectImage(tooWide), { code: 'IMAGE_DIMENSIONS' });
  const valid = await image(512, 512, { left: 0, top: 0, right: 512, bottom: 512 });
  await assert.rejects(inspectImage(Buffer.concat([valid, Buffer.alloc(41 * 1024 * 1024)])), { code: 'IMAGE_TOO_LARGE' });
});

test('an anti-aliased photo edge still counts as regular transparency', async () => {
  // 照片边缘的抗锯齿/描边会留下 alpha=1..254 的过渡像素。严格判定（必须恰好 255 或 0）
  // 会把它判成「不规则透明」，扩图直接被拦成「请先整理画布」——用户什么都没做错。
  const width = 600, height = 600, edge = 400;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 120; pixels[i + 1] = 140; pixels[i + 2] = 160;
      pixels[i + 3] = x < edge ? 255 : 0;
    }
  }
  for (let y = 0; y < height; y++) pixels[(y * width + edge) * 4 + 3] = 128;
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const info = await inspectImage(png);
  assert.equal(info.regularTransparency, true);
  assert.equal(info.opaqueBounds.right, edge + 1);
});

test('a translucent hole away from the edge is still irregular', async () => {
  const width = 600, height = 600;
  const pixels = Buffer.alloc(width * height * 4, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 120; pixels[i + 1] = 140; pixels[i + 2] = 160;
      pixels[i + 3] = x < 400 ? 255 : 0;
    }
  }
  // 照片内部挖一个半透明的洞：这不是边缘过渡，必须仍被判为不规则
  for (let y = 200; y < 260; y++) {
    for (let x = 100; x < 160; x++) pixels[(y * width + x) * 4 + 3] = 60;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  assert.equal((await inspectImage(png)).regularTransparency, false);
});

// ── 扩图底稿：延伸区不能「盖章」──────────────────────────────────────────
// 真实翻车：2618×2560 画布向右扩 570px，底稿是把照片边缘 60px 的窄条循环复制
// 铺出来的。窄条里正好含着笔筒和书堆，于是延伸区被盖上四五枚重复的印章。
// 模型照着底稿画，用户在 PS 里看到右边突然多出一个杯子、桌沿接不上——
// 「内容接不上」。问题不在提示词，在底稿这一步就已经错了。

async function roomPhoto() {
  const w = 200;
  const h = 200;
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 墙：从上到下有轻微渐变
      let v = 150 + Math.round((y / h) * 40);
      // 一条横贯全宽的「桌沿」，用来验证水平结构能接着走
      if (y >= 96 && y < 104) v = 235;
      // 一个不贴右边缘的物体（笔筒），旧算法会把它复制到延伸区
      if (x >= 176 && x < 196 && y >= 130 && y < 170) v = 40;
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

const ROOM_CANVAS = { width: 260, height: 200 };
const ROOM_BOUNDS = { left: 0, top: 0, right: 200, bottom: 200 };

test('延伸区不会把贴着边缘的物体复制一份', async () => {
  const photo = await roomPhoto();
  const filled = await buildExpandInput(photo, ROOM_CANVAS, ROOM_BOUNDS);
  const { data, info } = await sharp(filled).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, ROOM_CANVAS.width);
  assert.equal(info.height, ROOM_CANVAS.height);
  let dark = 0;
  for (let y = 120; y < 180; y++) {
    for (let x = 200; x < ROOM_CANVAS.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] < 90) dark++;
    }
  }
  // 旧实现（窄条循环复制）在这里会得到成片的暗色「笔筒印章」
  assert.equal(dark, 0, '延伸区不该出现原图物体的复制');
});

test('延伸区接着原图的水平结构走，接缝处没有台阶', async () => {
  const photo = await roomPhoto();
  const filled = await buildExpandInput(photo, ROOM_CANVAS, ROOM_BOUNDS);
  const { data, info } = await sharp(filled).raw().toBuffer({ resolveWithObject: true });
  const luma = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  // 桌沿那一行在延伸区继续保持亮
  assert.ok(luma(250, 100) > luma(250, 60) + 40, '桌沿必须延续到延伸区');
  // 接缝两侧不出现跳变
  for (const y of [40, 100, 160]) {
    assert.ok(Math.abs(luma(199, y) - luma(200, y)) < 6, 'x=200 处不该有台阶');
  }
  // 远处的颜色也不能跑偏（趋势按 band 饱和，不会无限斜坡）
  assert.ok(Math.abs(luma(255, 30) - luma(190, 30)) < 25);
});
