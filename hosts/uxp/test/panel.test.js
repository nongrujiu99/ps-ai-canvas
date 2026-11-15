const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../src/panel');

test('UXP controller previews a result and applies its raw pixels only after acceptance', async () => {
  const raw = { width: 2, height: 2, data: new Uint8Array(16) };
  const result = { preview: 'data:image/png;base64,AA==', loadRaw: async () => raw };
  let applied = null;
  const host = { capture: async () => ({ image: { kind: 'rgba' }, mask: { kind: 'gray8' }, context: {} }), apply: async (preview) => { applied = preview; return { layerId: 3 }; } };
  const service = { inspect: async () => ({ selectionKind: 'inside' }), start: async () => ({ jobId: 'id' }), get: async () => ({ status: 'succeeded', resultCount: 1 }), result: async () => result };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit' });
  assert.equal(applied, null);
  assert.equal(controller.state().previews[0].preview, result.preview);
  await controller.accept(0);
  // 控制器不解释预览结构，原样交给 host；host 在应用时再按需取 RGBA。
  assert.equal(applied, result);
  assert.deepEqual(await applied.loadRaw(), raw);
});

test('stopping a running job keeps late poll results out of the preview', async () => {
  let finishPoll;
  const host = { openSeparate: async () => ({}) };
  const service = {
    start: async () => ({ jobId: 'id' }),
    get: () => new Promise((resolve) => { finishPoll = resolve; }),
    cancel: async () => ({ status: 'cancelled' }),
  };
  const controller = createController({ host, service, wait: async () => {} });
  const running = controller.run({ mode: 'generate', prompt: '花瓶' });
  while (!finishPoll) await new Promise((resolve) => setImmediate(resolve));
  await controller.cancel();
  finishPoll({ status: 'succeeded', resultCount: 1 });
  await running;
  assert.equal(controller.state().status, 'cancelled');
  assert.deepEqual(controller.state().previews, []);
});

function expandScene(inspection, withMask = false) {
  const calls = [];
  let disposed = 0;
  const host = {
    capture: async (operation) => {
      calls.push(['capture', operation]);
      return {
        image: { kind: 'rgba', width: 2000, height: 2560, dataBase64: '' },
        mask: withMask ? { kind: 'gray8', width: 2000, height: 2560, dataBase64: '' } : null,
        // UXP 现在也会把活动图层范围带进 context——扩图靠它算「原图在画布里的位置」。
        context: { documentId: 1, operation, layerBounds: { left: 0, top: 0, right: 2000, bottom: 2560 } }
      };
    },
    dispose: () => { disposed++; },
    apply: async () => ({ layerId: 2 }),
    openSeparate: async () => ({ documentId: 3 }),
  };
  const service = {
    inspect: async () => inspection,
    start: async (job) => { calls.push(['start', job]); return { jobId: 'job-1' }; },
    get: async () => ({ status: 'succeeded', resultCount: 0 }),
    result: async () => ({ preview: 'data:image/png;base64,AA==' }),
    cancel: async () => ({ status: 'cancelled' }),
  };
  return { calls, host, service, disposed: () => disposed };
}

test('UXP expansion reuses the scales derived from the canvas and sends the layer bounds', async () => {
  // 这一条是 UXP 以前缺的行为：没有选区时直接拿滑块默认值提交，
  // 服务端照做，生成一张方向错的扩图，全程不报错。
  const { calls, host, service } = expandScene({ selectionKind: 'none', expandScales: { top: 1, right: 1.432, bottom: 1, left: 1 } });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1.5, bottom: 1, left: 1 } });
  const job = calls.find((x) => x[0] === 'start')[1];
  assert.equal(job.scales.right, 1.432);
  assert.deepEqual(job.canvasBounds, { left: 0, top: 0, right: 2000, bottom: 2560 });
  assert.equal(controller.state().appliedScales.right, 1.432);
});

test('UXP expansion points at the transparent area instead of saying "invalid selection"', async () => {
  const { calls, host, service } = expandScene({
    selectionKind: 'inside',
    transparentBounds: { left: 100, top: 0, right: 500, bottom: 2560 },
    selectionBounds: { left: 600, top: 100, right: 700, bottom: 300 }
  }, true);
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1.5, bottom: 1, left: 1 } }),
    (error) => error.code === 'INVALID_SELECTION' && /透明区在 x 100 ~ 500/.test(error.message) && /你的选区在 x 600 ~ 700/.test(error.message));
  assert.equal(calls.filter((x) => x[0] === 'start').length, 0);
});

test('UXP rejects a pixel count typed into a scale field instead of sending it', async () => {
  const { calls, host, service } = expandScene({ selectionKind: 'none' });
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1398, bottom: 1, left: 1 } }),
    (error) => error.code === 'INVALID_SCALE' && /倍率/.test(error.message));
  assert.equal(calls.filter((x) => x[0] === 'start').length, 0);
});

test('UXP releases the temporary capture when a run fails before submitting', async () => {
  const { host, service, disposed } = expandScene({ selectionKind: 'ambiguous' }, true);
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1.5, bottom: 1, left: 1 } }));
  assert.equal(disposed(), 1);
});
