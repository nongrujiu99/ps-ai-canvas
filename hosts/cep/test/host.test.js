const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, scriptCall } = require('../js/host');

test('script arguments preserve quoted Windows paths without executing code', () => {
  const call = scriptCall('apply', ['C:\\Temp\\a"b.png', { documentId: 7 }]);
  assert.equal(call, 'PSAI.apply("C:\\\\Temp\\\\a\\"b.png",{"documentId":7})');
});

test('adapter decodes host JSON and reports ExtendScript failures', async () => {
  const cs = { evalScript: (_, done) => done('{"ok":true,"value":{"documentId":7,"width":512}}') };
  const host = createHost({ cs, fs: {}, encoding: { Base64: 1 } });
  assert.equal((await host.inspect()).documentId, 7);
  cs.evalScript = (_, done) => done('{"ok":false,"code":"NO_DOCUMENT","message":"请打开文档。"}');
  await assert.rejects(host.inspect(), { code: 'NO_DOCUMENT' });
});

test('capture reads temporary PNGs as Base64 and preserves the document snapshot', async () => {
  const scripts = [];
  const cs = { evalScript: (script, done) => { scripts.push(script); done(JSON.stringify({ ok: true, value: { context: { documentId: 10, historyId: 20 }, imagePath: 'C:\\Temp\\source.png', maskPath: 'C:\\Temp\\mask.png' } })); } };
  const files = { 'C:\\Temp\\source.png': 'aW1hZ2U=', 'C:\\Temp\\mask.png': 'bWFzaw==' };
  const fs = { readFile: (path, encoding) => ({ err: 0, data: files[path], encoding }), deleteFile: () => ({ err: 0 }) };
  const host = createHost({ cs, fs, encoding: { Base64: 1 } });
  const capture = await host.capture('editMasked', {});
  assert.equal(capture.context.documentId, 10);
  assert.equal(capture.image.dataUrl, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(capture.mask.dataUrl, 'data:image/png;base64,bWFzaw==');
  assert.match(scripts[0], /^PSAI\.capture\(/);
});

test('accepted result is staged as PNG and applied by path', async () => {
  const scripts = [];
  const cs = { evalScript: (script, done) => { scripts.push(script); done('{"ok":true,"value":{"documentId":10,"layerId":3}}'); } };
  let written;
  const fs = { writeFile: (path, data, encoding) => { written = { path, data, encoding }; return { err: 0 }; }, deleteFile: () => ({ err: 0 }) };
  const host = createHost({ cs, fs, encoding: { Base64: 1 }, tempPath: () => 'C:\\Temp\\chosen.png' });
  const result = await host.apply('data:image/png;base64,cG5n', { context: { documentId: 10 } });
  assert.equal(written.data, 'cG5n');
  assert.equal(result.layerId, 3);
  assert.match(scripts[0], /^PSAI\.apply\(/);
});

test('a rejected application removes staged result and captured mask files', async () => {
  const removed = [];
  const cs = { evalScript: (_, done) => done('{"ok":false,"code":"STALE_DOCUMENT","message":"changed"}') };
  const fs = { writeFile: () => ({ err: 0 }), deleteFile: (path) => { removed.push(path); return { err: 0 }; } };
  const host = createHost({ cs, fs, encoding: { Base64: 1 }, tempPath: () => 'C:\\Temp\\result.png' });
  await assert.rejects(host.apply('data:image/png;base64,cG5n', { context: { documentId: 7 }, maskPath: 'C:\\Temp\\mask.png' }), { code: 'STALE_DOCUMENT' });
  assert.deepEqual(removed, ['C:\\Temp\\result.png', 'C:\\Temp\\mask.png']);
});

test('capture read failure removes both temporary Photoshop files', async () => {
  const removed = [];
  const cs = { evalScript: (_, done) => done(JSON.stringify({ ok: true, value: { imagePath: 'source.png', maskPath: 'mask.png', context: {} } })) };
  const fs = { readFile: (name) => name === 'source.png' ? { err: 0, data: 'cG5n' } : { err: 1 }, deleteFile: (name) => { removed.push(name); } };
  const host = createHost({ cs, fs, encoding: { Base64: 1 } });
  await assert.rejects(host.capture('editMasked'), /无法读取/);
  assert.deepEqual(removed, ['source.png', 'mask.png']);
});

test('abandoned capture releases its temporary mask', () => {
  const removed = [];
  const host = createHost({ cs: {}, fs: { deleteFile: (name) => removed.push(name) }, encoding: {} });
  host.dispose({ maskPath: 'mask.png' });
  assert.deepEqual(removed, ['mask.png']);
});

test('cropped capture sends a work mask and keeps the full selection mask for application', async () => {
  const removed = [];
  const cs = { evalScript: (_script, done) => done(JSON.stringify({ ok: true, value: { imagePath: 'image.png', maskPath: 'work-mask.png', applyMaskPath: 'full-mask.png', context: { workArea: { left: 100, top: 100, right: 612, bottom: 612 } } } })) };
  const fs = { readFile: () => ({ err: 0, data: 'cG5n' }), deleteFile: (name) => { removed.push(name); } };
  const host = createHost({ cs, fs, encoding: { Base64: 1 } });
  const capture = await host.capture('editMasked');
  assert.equal(capture.maskPath, 'full-mask.png');
  assert.equal(capture.workMaskPath, 'work-mask.png');
  host.dispose(capture);
  assert.deepEqual(removed, ['image.png', 'full-mask.png', 'work-mask.png']);
});
