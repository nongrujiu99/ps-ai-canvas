const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, scriptCall } = require('../js/host');

test('script arguments preserve quoted Windows paths without executing code', () => {
  const call = scriptCall('apply', ['C:\\Temp\\a"b.png', { documentId: 7 }]);
  assert.equal(call, 'Studio.apply("C:\\\\Temp\\\\a\\"b.png",{"documentId":7})');
});

test('adapter decodes host JSON and reports ExtendScript failures', async () => {
  const cs = { evalScript: (_, done) => done('{"ok":true,"value":{"documentId":7,"width":512}}') };
  const host = createHost({ cs, fs: {}, encoding: { Base64: 1 } });
  assert.equal((await host.inspect()).documentId, 7);
  cs.evalScript = (_, done) => done('{"ok":false,"code":"NO_DOCUMENT","message":"请打开文档。"}');
  await assert.rejects(host.inspect(), { code: 'NO_DOCUMENT' });
});

test('capture builds a gray8 mask from selection bounds without any Photoshop fill', async () => {
  const scripts = [];
  const context = {
    documentId: 10, historyId: 20, width: 500, height: 500,
    selectionBounds: { left: 100, top: 100, right: 200, bottom: 300 }
  };
  const cs = { evalScript: (script, done) => { scripts.push(script); done(JSON.stringify({ ok: true, value: { context, imagePath: 'C:\\Temp\\source.png' } })); } };
  const files = { 'C:\\Temp\\source.png': 'aW1hZ2U=' };
  const fs = { readFile: (path, encoding) => ({ err: 0, data: files[path], encoding }), deleteFile: () => ({ err: 0 }) };
  const host = createHost({ cs, fs, encoding: { Base64: 1 } });
  const capture = await host.capture('editMasked', {});
  assert.equal(capture.context.documentId, 10);
  assert.equal(capture.image.dataUrl, 'data:image/png;base64,aW1hZ2U=');
  // 遮罩是 JS 从选区坐标生成的 gray8 原始字节，不来自任何磁盘文件
  assert.equal(capture.mask.kind, 'gray8');
  assert.equal(capture.mask.width, 500);
  assert.equal(capture.mask.height, 500);
  const bytes = Buffer.from(capture.mask.dataBase64, 'base64');
  assert.equal(bytes.length, 500 * 500);
  const at = (x, y) => bytes[y * 500 + x];
  assert.equal(at(150, 200), 255, '选区内部为白');
  assert.equal(at(50, 200), 0, '选区外部为黑');
  assert.equal(capture.maskPath, null);
  assert.match(scripts[scripts.length - 1], /^Studio\.capture\(/);
  // 关键回归：桥接脚本里不再有任何 selection.fill —— 它会把原文档选区涂黑
  assert.ok(!scripts.some((s) => /selection\.fill|makeSelectionPng/.test(s)));
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
  // 首次调用会先加载 bridge（$.evalFile），业务调用是最后一条脚本
  assert.match(scripts[scripts.length - 1], /^Studio\.apply\(/);
});

test('a rejected application removes only the staged result', async () => {
  const removed = [];
  const cs = { evalScript: (_, done) => done('{"ok":false,"code":"STALE_DOCUMENT","message":"changed"}') };
  const fs = { writeFile: () => ({ err: 0 }), deleteFile: (path) => { removed.push(path); return { err: 0 }; } };
  const host = createHost({ cs, fs, encoding: { Base64: 1 }, tempPath: () => 'C:\\Temp\\result.png' });
  await assert.rejects(host.apply('data:image/png;base64,cG5n', { context: { documentId: 7 } }), { code: 'STALE_DOCUMENT' });
  assert.deepEqual(removed, ['C:\\Temp\\result.png']);
});

test('capture read failure removes the temporary Photoshop image', async () => {
  const removed = [];
  const cs = { evalScript: (_, done) => done(JSON.stringify({ ok: true, value: { imagePath: 'source.png', context: {} } })) };
  const fs = { readFile: () => ({ err: 1 }), deleteFile: (name) => { removed.push(name); } };
  const host = createHost({ cs, fs, encoding: { Base64: 1 } });
  await assert.rejects(host.capture('editMasked'), /无法读取/);
  assert.deepEqual(removed, ['source.png']);
});

test('abandoned capture needs no disk cleanup', () => {
  const removed = [];
  const host = createHost({ cs: {}, fs: { deleteFile: (name) => removed.push(name) }, encoding: {} });
  host.dispose({ maskPath: 'mask.png' });
  assert.deepEqual(removed, []);
});

test('cropped capture shifts the mask to the cropped work area', async () => {
  const workArea = { left: 100, top: 100, right: 612, bottom: 612 };
  const context = {
    width: 1000, height: 1000, workArea,
    selectionBounds: { left: 200, top: 250, right: 400, bottom: 450 }
  };
  const cs = { evalScript: (_script, done) => done(JSON.stringify({ ok: true, value: { imagePath: 'image.png', context } })) };
  const fs = { readFile: () => ({ err: 0, data: 'cG5n' }), deleteFile: () => {} };
  const host = createHost({ cs, fs, encoding: { Base64: 1 } });
  const capture = await host.capture('editMasked');
  // 遮罩尺寸 = 裁剪后的图像尺寸，不是整张画布
  assert.equal(capture.mask.width, 512);
  assert.equal(capture.mask.height, 512);
  const bytes = Buffer.from(capture.mask.dataBase64, 'base64');
  const at = (x, y) => bytes[y * 512 + x];
  // 选区 (200,250)-(400,450) 减去裁剪原点 (100,100) → 局部 (100,150)-(300,350)
  assert.equal(at(150, 200), 255, '裁剪图内选区位置为白');
  assert.equal(at(50, 200), 0, '裁剪图内选区外为黑');
  assert.equal(capture.maskPath, null);
});
