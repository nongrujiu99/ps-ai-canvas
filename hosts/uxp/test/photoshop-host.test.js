const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../src/photoshop-host');

function scene({ mode = 'RGB', depth = 'EIGHT', selection = { left: 0, top: 0, right: 2, bottom: 2 }, trim = false } = {}) {
  const calls = [];
  let disposed = 0;
  const doc = { id: 7, width: 2, height: 2, mode, bitsPerChannel: depth, activeHistoryState: { id: 9 }, selection: { bounds: selection }, colorProfileName: 'sRGB IEC61966-2.1', createPixelLayer: async () => ({ id: 55, delete: () => calls.push('delete') }) };
  const image = (bytes, width, height, components) => ({ width, height, components, getData: async () => Uint8Array.from(bytes), dispose: () => { disposed++; } });
  const imaging = {
    getPixels: async (args) => { calls.push(['getPixels', args.colorProfile]); return { sourceBounds: trim ? { left: 1, top: 0, right: 2, bottom: 2 } : { left: 0, top: 0, right: 2, bottom: 2 }, imageData: trim ? image([11, 22, 33, 255, 44, 55, 66, 255], 1, 2, 4) : image(Array(16).fill(255), 2, 2, 4) }; },
    getSelection: async () => ({ sourceBounds: { left: 0, top: 0, right: 2, bottom: 2 }, imageData: image([0, 80, 128, 255], 2, 2, 1) }),
    createImageDataFromBuffer: async (data, options) => { calls.push(['create', options.components, [...data]]); return image([], options.width, options.height, options.components); },
    putPixels: async (args) => calls.push(['pixels', args.layerID]),
    putLayerMask: async (args) => calls.push(['mask', args.layerID]),
  };
  const app = { activeDocument: doc, documents: [doc] };
  const core = { executeAsModal: async (fn) => fn() };
  const action = { batchPlay: async () => calls.push('make-mask') };
  const constants = { DocumentMode: { RGB: 'RGB' }, BitsPerChannelType: { EIGHT: 'EIGHT' } };
  return { calls, doc, app, imaging, core, action, constants, get disposed() { return disposed; } };
}

test('capture preserves full RGBA canvas, grayscale feather and disposes Photoshop buffers', async () => {
  const s = scene({ trim: true });
  const host = createHost(s);
  const capture = await host.capture('editMasked');
  assert.equal(capture.context.documentId, 7);
  assert.equal(capture.image.kind, 'rgba');
  const rgba = Buffer.from(capture.image.dataBase64, 'base64');
  assert.deepEqual([...rgba.slice(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...rgba.slice(4, 8)], [11, 22, 33, 255]);
  assert.deepEqual([...Buffer.from(capture.mask.dataBase64, 'base64')], [0, 80, 128, 255]);
  assert.equal(s.disposed, 2);
  assert.deepEqual(s.calls[0], ['getPixels', 'sRGB IEC61966-2.1']);
});

test('unsupported color mode or depth and absent selection fail before image access', async () => {
  for (const options of [{ mode: 'CMYK' }, { depth: 'SIXTEEN' }, { selection: null }]) {
    const s = scene(options);
    await assert.rejects(createHost(s).capture('editMasked'));
    assert.equal(s.disposed, 0);
  }
});

test('accepted masked result creates new layer, preserves gray feather and disposes import buffers', async () => {
  const s = scene();
  const host = createHost(s);
  const capture = await host.capture('editMasked');
  const raw = { data: Uint8Array.from(Array(16).fill(255)), width: 2, height: 2 };
  const result = await host.apply(raw, capture);
  assert.equal(result.layerId, 55);
  assert.deepEqual(s.calls.filter((c) => Array.isArray(c) && c[0] === 'create').map((c) => c[1]), [4, 1]);
  assert.deepEqual(s.calls.find((c) => Array.isArray(c) && c[0] === 'create' && c[1] === 1)[2], [0, 80, 128, 255]);
  assert.ok(s.calls.includes('make-mask'));
  assert.equal(s.disposed, 4);
});

test('changed active document rejects application before creating a layer', async () => {
  const s = scene();
  const host = createHost(s);
  const capture = await host.capture('editMasked');
  s.app.activeDocument = { ...s.doc, id: 8 };
  await assert.rejects(host.apply({ data: new Uint8Array(16), width: 2, height: 2 }, capture), { code: 'STALE_DOCUMENT' });
  assert.equal(s.calls.filter((call) => Array.isArray(call) && ['create', 'pixels', 'mask'].includes(call[0])).length, 0);
});

test('text generation opens a new document and removes it if pixel placement fails', async () => {
  const s = scene();
  s.app.createDocument = async (options) => {
    s.calls.push(['document', options.width, options.height]);
    return { id: 88, width: options.width, height: options.height, createPixelLayer: async () => ({ id: 56, delete: () => s.calls.push('delete-layer') }), closeWithoutSaving: () => s.calls.push('close-document') };
  };
  s.constants.NewDocumentMode = { RGB: 'RGB' };
  s.constants.DocumentFill = { TRANSPARENT: 'TRANSPARENT' };
  const host = createHost(s);
  const raw = { data: new Uint8Array(16), width: 2, height: 2 };
  assert.deepEqual(await host.openSeparate(raw), { documentId: 88 });
  assert.deepEqual(s.calls[0], ['document', 2, 2]);
  s.imaging.putPixels = async () => { throw new Error('pixels failed'); };
  await assert.rejects(host.openSeparate(raw), /pixels failed/);
  assert.ok(s.calls.includes('delete-layer'));
  assert.ok(s.calls.includes('close-document'));
});
