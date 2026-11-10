const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('runtime binds a fresh provider to the configured Beijing workspace for a job', async () => {
  const { createRuntime } = require('../src/main');
  const calls = [];
  const credentialStore = { read: async () => ({ apiKey: 'test-only-key', workspaceId: 'ws_123' }) };
  const server = createRuntime({ credentialStore, clientToken: 'a'.repeat(43), providerFactory: (config) => {
    calls.push(config);
    return { submit: async () => ({ taskId: 'remote-id' }), poll: async () => ({ status: 'FAILED', resultUrls: [] }) };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/jobs', method: 'POST', headers: { 'X-PSAI-Client': 'ps-ai-plugin', 'X-PSAI-Token': 'a'.repeat(43), 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify({ operation: 'generate', prompt: '花瓶' }));
    });
    assert.equal(status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, 'https://ws_123.cn-beijing.maas.aliyuncs.com');
    assert.equal(calls[0].apiKey, 'test-only-key');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
