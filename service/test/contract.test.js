const test = require('node:test');
const assert = require('node:assert/strict');
const { validateJob } = require('../src/contract');

const image = { kind: 'encoded', dataUrl: 'data:image/png;base64,aGVsbG8=' };
const mask = { kind: 'gray8', width: 2, height: 2, dataBase64: '/////w==' };

test('masked edit uses one candidate and a natural-fill prompt when the user leaves it blank', () => {
  const job = validateJob({ operation: 'editMasked', image, mask, prompt: '' });
  assert.equal(job.n, 1);
  assert.match(job.prompt, /自然|延伸|背景/);
  assert.equal(job.operation, 'editMasked');
});

test('whole repaint needs a user description and accepts strength only there', () => {
  assert.throws(() => validateJob({ operation: 'editWhole', image, prompt: '' }), { code: 'PROMPT_REQUIRED' });
  assert.equal(validateJob({ operation: 'editWhole', image, prompt: '把天空改成黄昏', strength: 0.7 }).strength, 0.7);
  assert.throws(() => validateJob({ operation: 'editMasked', image, mask, strength: 0.7 }), { code: 'UNSUPPORTED_OPTION' });
});

test('expansion requires a changed direction within the model limit', () => {
  const job = validateJob({ operation: 'expand', image, scales: { top: 1, right: 1.4, bottom: 1, left: 1 } });
  assert.equal(job.scales.right, 1.4);
  assert.match(job.prompt, /延伸|自然/);
  assert.throws(() => validateJob({ operation: 'expand', image, scales: { top: 1, right: 1, bottom: 1, left: 1 } }), { code: 'NO_EXPANSION' });
  assert.throws(() => validateJob({ operation: 'expand', image, scales: { top: 1, right: 2.1, bottom: 1, left: 1 } }), { code: 'INVALID_SCALE' });
});

test('generation requires a description and candidate count stays between one and four', () => {
  assert.throws(() => validateJob({ operation: 'generate', prompt: '' }), { code: 'PROMPT_REQUIRED' });
  assert.equal(validateJob({ operation: 'generate', prompt: '白色陶瓷花瓶', size: '1024*1024', n: 4 }).n, 4);
  assert.throws(() => validateJob({ operation: 'generate', prompt: '花瓶', n: 0 }), { code: 'INVALID_COUNT' });
  assert.throws(() => validateJob({ operation: 'generate', prompt: '花瓶', n: 5 }), { code: 'INVALID_COUNT' });
});

test('invalid operation and missing source fail before a provider can be called', () => {
  assert.throws(() => validateJob({ operation: 'erase', image }), { code: 'INVALID_OPERATION' });
  assert.throws(() => validateJob({ operation: 'editWhole', prompt: '修改颜色' }), { code: 'IMAGE_REQUIRED' });
  assert.throws(() => validateJob({ operation: 'editMasked', image, prompt: '换成花' }), { code: 'MASK_REQUIRED' });
});
