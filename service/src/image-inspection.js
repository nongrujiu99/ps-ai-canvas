'use strict';

const sharp = require('sharp');
const { problem } = require('./contract');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw problem('INVALID_IMAGE_DATA', '图像编码无效。');
  }
  return Buffer.from(value, 'base64');
}

async function decodeOne(source, expectedKind) {
  if (!source || typeof source !== 'object') throw problem('INVALID_IMAGE_DATA', '缺少图像数据。');
  if (source.kind === 'encoded') {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(source.dataUrl || '');
    if (!match) throw problem('INVALID_IMAGE_DATA', '仅支持 PNG 或 JPEG 图像。');
    return decodeBase64(match[2]);
  }
  const components = expectedKind === 'image' ? 4 : 1;
  const kind = expectedKind === 'image' ? 'rgba' : 'gray8';
  if (source.kind !== kind || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1) {
    throw problem('INVALID_IMAGE_DATA', '原始像素参数无效。');
  }
  const bytes = decodeBase64(source.dataBase64);
  if (bytes.length !== source.width * source.height * components) {
    throw problem('INVALID_IMAGE_DATA', '原始像素长度与尺寸不符。');
  }
  return sharp(bytes, { raw: { width: source.width, height: source.height, channels: components } }).png().toBuffer();
}

async function decodeCapture(image, mask) {
  const pngBytes = await decodeOne(image, 'image');
  const maskBytes = mask ? await decodeOne(mask, 'mask') : undefined;
  return { pngBytes, maskBytes };
}

async function inspectImage(pngBytes, maskBytes) {
  if (!Buffer.isBuffer(pngBytes) || pngBytes.length > MAX_IMAGE_BYTES) {
    throw problem('IMAGE_TOO_LARGE', '图像文件超过 10 MB。');
  }
  const meta = await sharp(pngBytes).metadata();
  const { width, height } = meta;
  if (width < 512 || width > 4096 || height < 512 || height > 4096) {
    throw problem('IMAGE_DIMENSIONS', '图像宽高需在 512 到 4096 像素之间。');
  }
  if (meta.depth && meta.depth !== 'uchar') {
    throw problem('IMAGE_DEPTH', '仅支持 8 位图像。');
  }
  if (meta.space && !['srgb', 'rgb'].includes(meta.space)) {
    throw problem('IMAGE_COLOR_MODE', '仅支持 RGB 图像。');
  }

  const pixels = await sharp(pngBytes).ensureAlpha().raw().toBuffer();
  let left = width, top = height, right = 0, bottom = 0;
  let transparentCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha === 0) {
        transparentCount++;
      } else {
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
    }
  }
  if (right === 0 || bottom === 0) throw problem('NO_OPAQUE_REGION', '找不到不透明原图区域。');
  const opaqueBounds = { left, top, right, bottom };
  let regular = true;
  if (transparentCount > 0) {
    for (let y = 0; y < height && regular; y++) {
      for (let x = 0; x < width; x++) {
        const expected = x >= left && x < right && y >= top && y < bottom ? 255 : 0;
        if (pixels[(y * width + x) * 4 + 3] !== expected) {
          regular = false;
          break;
        }
      }
    }
  }

  let selectionKind = 'none';
  if (maskBytes) {
    const maskMeta = await sharp(maskBytes).metadata();
    if (maskMeta.width !== width || maskMeta.height !== height) {
      throw problem('MASK_DIMENSIONS', '选区遮罩尺寸与图像不一致。');
    }
    const selected = await sharp(maskBytes).removeAlpha().greyscale().raw().toBuffer();
    let selectedOpaque = 0, selectedTransparent = 0, missingTransparent = 0;
    for (let i = 0; i < width * height; i++) {
      const alpha = pixels[i * 4 + 3];
      if (selected[i] > 0) {
        if (alpha === 255) selectedOpaque++;
        else selectedTransparent++;
      } else if (alpha === 0) {
        missingTransparent++;
      }
    }
    if (selectedOpaque || selectedTransparent) {
      if (!regular || (selectedOpaque && selectedTransparent)) selectionKind = 'ambiguous';
      else if (selectedTransparent) selectionKind = missingTransparent === 0 ? 'transparentBorder' : 'ambiguous';
      else selectionKind = 'inside';
    }
  }

  return { width, height, opaqueBounds, selectionKind, regularTransparency: regular };
}

async function prepareExpansion(pngBytes, maskBytes) {
  const info = await inspectImage(pngBytes, maskBytes);
  if (info.selectionKind !== 'transparentBorder') {
    throw problem('NOT_EXPANSION_SELECTION', '选区不是规则透明边缘。');
  }
  const { left, top, right, bottom } = info.opaqueBounds;
  const originalWidth = right - left;
  const originalHeight = bottom - top;
  const scales = {
    topScale: 1 + top / originalHeight,
    rightScale: 1 + (info.width - right) / originalWidth,
    bottomScale: 1 + (info.height - bottom) / originalHeight,
    leftScale: 1 + left / originalWidth,
  };
  if (Object.values(scales).some((scale) => scale > 2)) {
    throw problem('INVALID_SCALE', '透明边缘超出模型单次扩图范围。');
  }
  const originalPng = await sharp(pngBytes).extract({ left, top, width: originalWidth, height: originalHeight }).png().toBuffer();
  return { originalPng, ...scales };
}

module.exports = { decodeCapture, inspectImage, prepareExpansion };
