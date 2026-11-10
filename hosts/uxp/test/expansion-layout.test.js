const test = require('node:test');
const assert = require('node:assert/strict');
const { expansionLayout, borderMask } = require('../src/expansion-layout');

test('four independent scale values determine the new canvas and original position', () => {
  const snapshot = { width: 1000, height: 800, scales: { left: 1.2, right: 1.3, top: 1.1, bottom: 1.4 } };
  assert.deepEqual(expansionLayout(snapshot, { width: 1500, height: 1200 }), { left: 200, right: 300, top: 80, bottom: 320 });
  assert.throws(() => expansionLayout(snapshot, { width: 1501, height: 1200 }), { code: 'EXPANSION_REVIEW' });
});

test('new expansion layer reveals only generated border pixels', () => {
  assert.deepEqual([...borderMask(4, 3, 2, 2, 1, 0)], [255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]);
});
