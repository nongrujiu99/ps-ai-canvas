const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { decodeCapture, inspectImage, prepareExpansion } = require('../src/image-inspection');

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
  const tooWide = await image(4097, 512, { left: 0, top: 0, right: 4097, bottom: 512 });
  await assert.rejects(inspectImage(tooWide), { code: 'IMAGE_DIMENSIONS' });
  const valid = await image(512, 512, { left: 0, top: 0, right: 512, bottom: 512 });
  await assert.rejects(inspectImage(Buffer.concat([valid, Buffer.alloc(10 * 1024 * 1024)])), { code: 'IMAGE_TOO_LARGE' });
});
