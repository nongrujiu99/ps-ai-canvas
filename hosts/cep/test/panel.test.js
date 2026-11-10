const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../js/panel');

function fake() {
  const calls = [];
  const host = { capture: async (operation) => { calls.push(['capture', operation]); return { image: { kind: 'encoded', dataUrl: 'data:image/png;base64,AA==' }, mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,AA==' }, context: { documentId: 1, operation } }; }, apply: async () => ({ layerId: 2 }), openSeparate: async () => ({ documentId: 3 }) };
  const service = { inspect: async () => ({ selectionKind: 'inside' }), start: async (job) => { calls.push(['start', job]); return { jobId: 'job-1' }; }, get: async () => ({ status: 'succeeded', resultCount: 1 }), result: async () => 'data:image/png;base64,AA==', cancel: async () => ({ status: 'cancelled' }) };
  return { calls, host, service };
}

test('masked fill defaults to one candidate and allows an empty prompt', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {} });
  controller.setMode('edit');
  await controller.run({ prompt: '' });
  assert.equal(calls[1][1].operation, 'editMasked');
  assert.equal(calls[1][1].n, 1);
  assert.equal(controller.state().status, 'preview');
  assert.equal(calls.filter((x) => x[0] === 'start').length, 1);
});

test('manual transparent-border selection routes into expansion', async () => {
  const { calls, host, service } = fake();
  service.inspect = async () => ({ selectionKind: 'transparentBorder' });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  assert.equal(calls[1][1].operation, 'expand');
  assert.ok(calls[1][1].mask);
});

test('missing or ambiguous selection refuses a billable request', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {} });
  service.inspect = async () => ({ selectionKind: 'ambiguous' });
  await assert.rejects(controller.run({ mode: 'edit' }), { code: 'AMBIGUOUS_SELECTION' });
  assert.equal(calls.filter((x) => x[0] === 'start').length, 0);
});

test('generation and whole repaint require a user description', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(controller.run({ mode: 'generate', prompt: '' }), { code: 'PROMPT_REQUIRED' });
  await assert.rejects(controller.run({ mode: 'edit', whole: true, prompt: '' }), { code: 'PROMPT_REQUIRED' });
  assert.equal(calls.length, 0);
});

test('extra candidates need confirmation and a failed network call leaves controls ready', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {}, confirmCost: () => false });
  await assert.rejects(controller.run({ mode: 'generate', prompt: '花瓶', n: 2 }), { code: 'COST_DECLINED' });
  service.start = async () => { throw new Error('offline'); };
  await assert.rejects(controller.run({ mode: 'generate', prompt: '花瓶' }), /offline/);
  assert.equal(controller.state().status, 'error');
  assert.equal(calls.length, 0);
});

test('accepting a changed document opens the chosen result separately', async () => {
  const { host, service } = fake();
  host.apply = async () => { const e = new Error('changed'); e.code = 'STALE_DOCUMENT'; throw e; };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  const result = await controller.accept(0);
  assert.deepEqual(result, { documentId: 3 });
});
