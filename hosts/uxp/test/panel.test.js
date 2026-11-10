const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../src/panel');

test('UXP controller previews a result and applies its raw pixels only after acceptance', async () => {
  const raw = { width: 2, height: 2, data: new Uint8Array(16) };
  const result = { preview: 'data:image/png;base64,AA==', raw };
  let applied = null;
  const host = { capture: async () => ({ image: { kind: 'rgba' }, mask: { kind: 'gray8' }, context: {} }), apply: async (pixels) => { applied = pixels; return { layerId: 3 }; } };
  const service = { inspect: async () => ({ selectionKind: 'inside' }), start: async () => ({ jobId: 'id' }), get: async () => ({ status: 'succeeded', resultCount: 1 }), result: async () => result };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit' });
  assert.equal(applied, null);
  assert.equal(controller.state().previews[0].preview, result.preview);
  await controller.accept(0);
  assert.equal(applied, raw);
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
