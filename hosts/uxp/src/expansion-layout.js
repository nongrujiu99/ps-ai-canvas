'use strict';

function expansionLayout(snapshot, result) {
  const scales = snapshot.scales;
  if (!scales) {
    const error = new Error('缺少扩图比例，结果将单独打开。');
    error.code = 'EXPANSION_REVIEW';
    throw error;
  }
  const width = snapshot.width, height = snapshot.height;
  const left = Math.round(width * (scales.left - 1));
  const right = Math.round(width * (scales.right - 1));
  const top = Math.round(height * (scales.top - 1));
  const bottom = Math.round(height * (scales.bottom - 1));
  if ([left, right, top, bottom].some((value) => !Number.isInteger(value) || value < 0) || result.width !== width + left + right || result.height !== height + top + bottom) {
    const error = new Error('模型输出尺寸与扩图比例不一致，结果将单独打开。');
    error.code = 'EXPANSION_REVIEW';
    throw error;
  }
  return { left, right, top, bottom };
}

function borderMask(width, height, originalWidth, originalHeight, offsetLeft, offsetTop) {
  const mask = new Uint8Array(width * height);
  mask.fill(255);
  for (let y = offsetTop; y < offsetTop + originalHeight; y++) mask.fill(0, y * width + offsetLeft, y * width + offsetLeft + originalWidth);
  return mask;
}

module.exports = { expansionLayout, borderMask };
