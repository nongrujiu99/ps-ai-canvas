const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createServer } = require('../src/server');

async function fixture() {
  const pixels = Buffer.alloc(512 * 512 * 4, 255);
  const png = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
  const gray = Buffer.alloc(512 * 512, 0);
  gray.fill(255, 0, 16);
  const mask = await sharp(gray, { raw: { width: 512, height: 512, channels: 1 } }).png().toBuffer();
  return { image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }, mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') } };
}

async function withServer(run, configured = true, options = {}) {
  const submitted = [];
  const credentialStore = { read: async () => configured ? { apiKey: 'secret-test-key', workspaceId: 'workspace' } : null, save: async () => {} };
  const jobManager = { start: async (job) => { submitted.push(job); return { jobId: '11111111-1111-4111-8111-111111111111', status: 'pending' }; }, get: () => ({ jobId: '11111111-1111-4111-8111-111111111111', status: 'succeeded', resultCount: 1, errorCode: null }), getResult: () => Buffer.from('result-png'), cancelWait: () => ({ jobId: '11111111-1111-4111-8111-111111111111', status: 'cancelled' }), ...options.jobManager };
  const server = createServer({ jobManager, credentialStore, allowedOrigins: ['plugin://psai'], ...options.server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run({ base: `http://127.0.0.1:${server.address().port}`, submitted }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const headers = { 'X-PSAI-Client': 'ps-ai-plugin', 'Content-Type': 'application/json', Origin: 'plugin://psai' };

test('non-billable inspection classifies a normal selection without submitting a job', async () => {
  await withServer(async ({ base, submitted }) => {
    const body = await fixture();
    const response = await fetch(base + '/v1/inspect', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selectionKind, 'inside');
    assert.equal(submitted.length, 0);
  });
});

test('a valid generation job is accepted once and can be polled', async () => {
  await withServer(async ({ base, submitted }) => {
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: '白色花瓶' }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).jobId, '11111111-1111-4111-8111-111111111111');
    assert.equal(submitted.length, 1);
    const status = await fetch(base + '/v1/jobs/11111111-1111-4111-8111-111111111111', { headers: { 'X-PSAI-Client': 'ps-ai-plugin', Origin: 'plugin://psai' } });
    assert.equal((await status.json()).resultCount, 1);
  });
});

test('foreign browser origin and missing plugin header cannot create a billable job', async () => {
  await withServer(async ({ base, submitted }) => {
    const body = JSON.stringify({ operation: 'generate', prompt: '花瓶' });
    const foreign = await fetch(base + '/v1/jobs', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body });
    const missing = await fetch(base + '/v1/jobs', { method: 'POST', headers: { Origin: 'plugin://psai', 'Content-Type': 'application/json' }, body });
    assert.equal(foreign.status, 403);
    assert.equal(missing.status, 403);
    assert.equal(submitted.length, 0);
  });
});

test('malformed JSON, wrong content type, and missing key fail before submission', async () => {
  await withServer(async ({ base, submitted }) => {
    const malformed = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: '{' });
    const wrongType = await fetch(base + '/v1/jobs', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(malformed.status, 400);
    assert.equal(wrongType.status, 415);
    assert.equal(submitted.length, 0);
  });
  await withServer(async ({ base, submitted }) => {
    const missingKey = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: '花瓶' }) });
    assert.equal(missingKey.status, 409);
    assert.equal(submitted.length, 0);
  }, false);
});

test('errors and credential status never expose a stored API key', async () => {
  await withServer(async ({ base }) => {
    const status = await fetch(base + '/v1/settings/status', { headers: { 'X-PSAI-Client': 'ps-ai-plugin', Origin: 'plugin://psai' } });
    assert.deepEqual(await status.json(), { configured: true, workspaceId: 'workspace' });
    const failed = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'editWhole', prompt: '' }) });
    assert.equal((await failed.text()).includes('secret-test-key'), false);
  });
});

test('oversized JSON is rejected before a paid submission', async () => {
  await withServer(async ({ base, submitted }) => {
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: 'a'.repeat(1024) }) });
    assert.equal(response.status, 413);
    assert.equal(submitted.length, 0);
  }, true, { server: { maxBodyBytes: 256 } });
});

test('result PNG and raw RGBA endpoints return local bytes and dimensions', async () => {
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#123456' } }).png().toBuffer();
  await withServer(async ({ base }) => {
    const url = base + '/v1/results/11111111-1111-4111-8111-111111111111/0';
    const pngResponse = await fetch(url, { headers: { 'X-PSAI-Client': 'ps-ai-plugin', Origin: 'plugin://psai' } });
    assert.equal(pngResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), png);
    const rawResponse = await fetch(url + '/raw', { headers: { 'X-PSAI-Client': 'ps-ai-plugin', Origin: 'plugin://psai' } });
    assert.equal(rawResponse.headers.get('x-image-width'), '2');
    assert.equal(rawResponse.headers.get('x-image-height'), '3');
    assert.equal((await rawResponse.arrayBuffer()).byteLength, 24);
  }, true, { jobManager: { getResult: () => png } });
});
