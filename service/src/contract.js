'use strict';

const OPERATIONS = new Set(['editMasked', 'editWhole', 'expand', 'generate']);
const DEFAULT_FILL_PROMPT = '自然补全选中区域，延续周围的背景、光线与纹理。';
const DEFAULT_EXPAND_PROMPT = '自然延伸原图画面，保持主体、光线和背景一致。';

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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

  return {
    operation,
    prompt,
    n,
    ...(operation === 'generate' ? { size } : {}),
    ...(operation === 'editMasked' ? { image: input.image, mask: input.mask } : {}),
    ...(operation === 'editWhole' ? { image: input.image, strength: input.strength === undefined ? 0.5 : input.strength } : {}),
    ...(operation === 'expand' ? { image: input.image, ...(scales ? { scales } : { mask: input.mask }) } : {}),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  };
}

module.exports = { validateJob, problem };
