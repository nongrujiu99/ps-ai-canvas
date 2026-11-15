'use strict';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// 查表用字符码而不是字符串：每 3 字节要 4 次索引，字符串索引每次都要建临时字符串，
// UXP 的 JS 引擎上处理 5 MB 级 PNG 时这一项很显眼。改成一整块 CharCode 数组后
// 每个分片只拼一次字符串，实测开销明显低。
const codes = new Uint8Array(64);
for (let i = 0; i < 64; i++) codes[i] = alphabet.charCodeAt(i);
const PAD = 61; // '='

function toBase64(bytes) {
  const parts = [];
  // 分片长度必须是 3 的倍数，否则跨分片的尾组会被多打一个 '='。
  const chunkSize = 3 * 4096;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    const out = new Array(Math.ceil((end - offset) / 3) * 4);
    let p = 0;
    for (let i = offset; i < end; i += 3) {
      const a = bytes[i];
      const hasB = i + 1 < end;
      const hasC = i + 2 < end;
      const b = hasB ? bytes[i + 1] : 0;
      const c = hasC ? bytes[i + 2] : 0;
      out[p++] = codes[a >> 2];
      out[p++] = codes[((a & 3) << 4) | (b >> 4)];
      out[p++] = hasB ? codes[((b & 15) << 2) | (c >> 6)] : PAD;
      out[p++] = hasC ? codes[c & 63] : PAD;
    }
    parts.push(String.fromCharCode.apply(null, out));
  }
  return parts.join('');
}

function paddedPixels(data, imageData, bounds, width, height, channels, originLeft = 0, originTop = 0) {
  const out = new Uint8Array(width * height * channels);
  const sourceChannels = imageData.components;
  for (let y = 0; y < imageData.height; y++) {
    for (let x = 0; x < imageData.width; x++) {
      const source = (y * imageData.width + x) * sourceChannels;
      const targetX = bounds.left + x - originLeft;
      const targetY = bounds.top + y - originTop;
      if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
      const target = (targetY * width + targetX) * channels;
      if (target < 0 || target + channels > out.length) continue;
      if (channels === 1) out[target] = data[source];
      else {
        out[target] = data[source]; out[target + 1] = data[source + 1]; out[target + 2] = data[source + 2];
        out[target + 3] = sourceChannels === 4 ? data[source + 3] : 255;
      }
    }
  }
  return out;
}

async function readFull(imaging, method, doc, channels) {
  return readBounds(imaging, method, doc, channels, { left: 0, top: 0, right: doc.width, bottom: doc.height });
}

async function readBounds(imaging, method, doc, channels, area) {
  const result = await imaging[method]({ documentID: doc.id, sourceBounds: area, ...(method === 'getPixels' ? { colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1', componentSize: 8, applyAlpha: false } : {}) });
  if (!result || !result.imageData) throw new Error('Photoshop 未返回图像像素。');
  try {
    const bytes = await result.imageData.getData({ chunky: true });
    return paddedPixels(bytes, result.imageData, result.sourceBounds, area.right - area.left, area.bottom - area.top, channels, area.left, area.top);
  } finally { result.imageData.dispose(); }
}

module.exports = { toBase64, paddedPixels, readFull, readBounds };
