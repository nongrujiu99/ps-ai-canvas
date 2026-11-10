const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bridge() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jsx', 'bridge.jsx'), 'utf8').replace(/^#.*$/gm, '');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.PSAI;
}

test('legacy bridge crops a large document around a small selection', () => {
  const area = bridge().workArea({ width: 10000, height: 8000, selectionBounds: { left: 6000, top: 4000, right: 6200, bottom: 4200 } });
  assert.equal(area.right - area.left, 712);
  assert.equal(area.bottom - area.top, 712);
  assert.ok(area.left <= 6000 && area.right >= 6200);
});

test('legacy bridge expands only when output dimensions match all four scales', () => {
  const snapshot = { width: 1000, height: 800, scales: { left: 1.2, right: 1.3, top: 1.1, bottom: 1.4 } };
  const layout = bridge().expandLayout(snapshot, 1500, 1200);
  assert.deepEqual(JSON.parse(JSON.stringify(layout)), { left: 200, right: 300, top: 80, bottom: 320 });
  assert.throws(() => bridge().expandLayout(snapshot, 1501, 1200), /尺寸/);
});
