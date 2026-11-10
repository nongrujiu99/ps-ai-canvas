'use strict';

function workArea(width, height, selection) {
  const full = { left: 0, top: 0, right: width, bottom: height };
  if (width <= 4096 && height <= 4096) return full;
  const selectedWidth = Math.ceil(selection.right) - Math.floor(selection.left);
  const selectedHeight = Math.ceil(selection.bottom) - Math.floor(selection.top);
  if (selectedWidth > 4096 || selectedHeight > 4096) {
    const error = new Error('选区超过 4096 像素，请缩小选区后重试。');
    error.code = 'SELECTION_TOO_LARGE';
    throw error;
  }
  function axis(length, start, end) {
    const size = Math.min(length, 4096, Math.max(512, Math.ceil(end) - Math.floor(start) + 512));
    const center = (start + end) / 2;
    const left = Math.max(0, Math.min(length - size, Math.floor(center - size / 2)));
    return [left, left + size];
  }
  const [left, right] = axis(width, selection.left, selection.right);
  const [top, bottom] = axis(height, selection.top, selection.bottom);
  return { left, top, right, bottom };
}

module.exports = { workArea };
