const test = require('node:test');
const assert = require('node:assert/strict');
const { workArea } = require('../src/work-area');
const { paddedPixels } = require('../src/imaging-adapter');

test('a small selection in a large document gets a bounded contextual work area', () => {
  const area = workArea(10000, 8000, { left: 6000, top: 4000, right: 6200, bottom: 4200 });
  assert.equal(area.right - area.left, 712);
  assert.equal(area.bottom - area.top, 712);
  assert.ok(area.left <= 6000 && area.right >= 6200);
  assert.ok(area.top <= 4000 && area.bottom >= 4200);
  assert.throws(() => workArea(10000, 8000, { left: 0, top: 0, right: 5000, bottom: 100 }), { code: 'SELECTION_TOO_LARGE' });
});

test('trimmed Photoshop pixels are padded relative to a cropped work area', () => {
  const pixels = paddedPixels(Uint8Array.from([9, 8, 7, 255]), { width: 1, height: 1, components: 4 }, { left: 6, top: 8 }, 3, 2, 4, 5, 7);
  assert.deepEqual([...pixels.slice(16, 20)], [9, 8, 7, 255]);
});
