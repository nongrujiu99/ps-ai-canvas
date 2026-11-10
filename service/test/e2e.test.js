const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createRuntime } = require('../src/main');

test('one mocked paid job moves through loopback service to PNG and raw result without a cloud request', async () => {
  const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#abcdef' } }).png().toBuffer();
  let submits = 0;
  const server = createRuntime({
    credentialStore: { read: async () => ({ apiKey: 'test-only', workspaceId: 'workspace' }) },
    providerFactory: () => ({ submit: async () => { submits++; return { taskId: 'mock-task' }; }, poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['https://mock.oss-cn-beijing.aliyuncs.com/test.png'] }), download: async () => png }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'X-PSAI-Client': 'ps-ai-plugin', 'Content-Type': 'application/json' };
    const start = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: '花瓶' }) });
    assert.equal(start.status, 202);
    const { jobId } = await start.json();
    let job;
    for (let i = 0; i < 20; i++) {
      job = await (await fetch(base + '/v1/jobs/' + jobId, { headers })).json();
      if (job.status === 'succeeded') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(job.status, 'succeeded');
    assert.equal(submits, 1);
    const image = await fetch(base + '/v1/results/' + jobId + '/0', { headers });
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const raw = await fetch(base + '/v1/results/' + jobId + '/0/raw', { headers });
    assert.equal(raw.headers.get('x-image-width'), '3');
    assert.equal((await raw.arrayBuffer()).byteLength, 3 * 2 * 4);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
