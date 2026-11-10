'use strict';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes) {
  const parts = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? alphabet[c & 63] : '=');
    if (chunk.length >= 16384) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
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
