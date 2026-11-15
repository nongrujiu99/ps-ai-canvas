'use strict';

const OPERATIONS = new Set(['editMasked', 'editWhole', 'expand', 'generate']);
const DEFAULT_FILL_PROMPT = '自然补全选中区域，延续周围的背景、光线与纹理。';
// 默认扩图提示词：明确「保持原图场景与材质类型」。
// 之前只写「延续背景、光线与材质」，模型容易把桌面、墙面这类平整表面
// 画成粗糙岩石/砂地——它只看到边缘一块模糊像素，需要这句来锚定语义。
const DEFAULT_EXPAND_PROMPT = '自然延伸原图画面，保持原图的场景类型与材质不变；画面中原有的人、手、物体必须保持原有形状和位置，不要重绘、变形、延展或复制到延伸区。';

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 扩图时 Photoshop 会带上「原照片在画布里的实际范围」（layer.bounds）。
// 这是唯一可信的几何来源：服务端自己分析 PNG 的 alpha 反推，遇到照片边缘的
// 半透明描边/投影就会算大，条带被挤成几像素，合成出一张几乎全透明的图，
// 用户看到的是「扩图区合并后不见了」。这里只放行 4 个有限数值，形状不对就当作
// 没传，让服务端退回反推——畸形范围比没有范围更危险。
function canvasBoundsOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  const rect = {};
  for (const side of ['left', 'top', 'right', 'bottom']) {
    const size = Number(value[side]);
    if (!Number.isFinite(size)) return undefined;
    rect[side] = size;
  }
  return rect;
}

function validateJob(input) {
  if (!input || !OPERATIONS.has(input.operation)) {
    throw problem('INVALID_OPERATION', '不支持的图像操作。');
  }
  const operation = input.operation;
  if (operation !== 'generate' && !input.image) {
    throw problem('IMAGE_REQUIRED', '需要当前图像。');
  }
  if (operation === 'editMasked' && !input.mask) {
    throw problem('MASK_REQUIRED', '需要选区遮罩。');
  }

  const n = input.n === undefined ? 1 : input.n;
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw problem('INVALID_COUNT', '候选数量必须为 1 到 4。');
  }

  let prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt && (operation === 'generate' || operation === 'editWhole')) {
    throw problem('PROMPT_REQUIRED', '请先输入画面描述。');
  }
  if (!prompt && operation === 'editMasked') prompt = DEFAULT_FILL_PROMPT;
  if (!prompt && operation === 'expand') prompt = DEFAULT_EXPAND_PROMPT;

  if (input.strength !== undefined && operation !== 'editWhole') {
    throw problem('UNSUPPORTED_OPTION', '此操作不支持修改幅度。');
  }
  if (input.strength !== undefined && (!Number.isFinite(input.strength) || input.strength < 0 || input.strength > 1)) {
    throw problem('INVALID_STRENGTH', '修改幅度必须在 0 到 1 之间。');
  }

  let scales;
  if (operation === 'expand') {
    if (input.mask && input.scales) {
      throw problem('UNSUPPORTED_OPTION', '选区扩图与方向比例不能同时使用。');
    }
    if (!input.mask) {
      scales = {};
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const value = input.scales && input.scales[side];
        if (!Number.isFinite(value) || value < 1 || value > 2) {
          throw problem('INVALID_SCALE', '扩图比例必须在 1.0 到 2.0 之间。');
        }
        scales[side] = value;
      }
      if (Object.values(scales).every((value) => value === 1)) {
        throw problem('NO_EXPANSION', '至少一个方向需要扩展。');
      }
    }
  }

  if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647)) {
    throw problem('INVALID_SEED', '随机种子无效。');
  }

  let size;
  if (operation === 'generate') {
    size = input.size === undefined ? '1024*1024' : input.size;
    const match = typeof size === 'string' && /^(\d+)\*(\d+)$/.exec(size);
    if (!['1K', '2K'].includes(size) && (!match || Number(match[1]) * Number(match[2]) < 768 * 768 || Number(match[1]) * Number(match[2]) > 2048 * 2048 || Math.max(Number(match[1]), Number(match[2])) / Math.min(Number(match[1]), Number(match[2])) > 8)) {
      throw problem('INVALID_SIZE', '生成尺寸超出模型支持范围。');
    }
  }

  // 只解析一次：原来在展开对象里连调了两次 canvasBoundsOf，同一份工作做了两遍。
  const bounds = operation === 'expand' ? canvasBoundsOf(input.canvasBounds) : undefined;

  return {
    operation,
    prompt,
    n,
    ...(operation === 'generate' ? { size } : {}),
    ...(operation === 'editMasked' ? { image: input.image, mask: input.mask } : {}),
    ...(operation === 'editWhole' ? { image: input.image, strength: input.strength === undefined ? 0.5 : input.strength } : {}),
    ...(operation === 'expand' ? { image: input.image, ...(scales ? { scales } : { mask: input.mask }), ...(bounds ? { canvasBounds: bounds } : {}) } : {}),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  };
}

// DEFAULT_EXPAND_PROMPT 一起导出：BFL 那条线要区分「用户自己写的」和
// 「框架兜底的中文默认句」——后者对英文模型是负分，不该发出去。
module.exports = { validateJob, problem, DEFAULT_EXPAND_PROMPT, DEFAULT_FILL_PROMPT };
