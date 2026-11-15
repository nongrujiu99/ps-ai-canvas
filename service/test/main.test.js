const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannelStore } = require('../src/channel-store');

// channel-store 默认读 %APPDATA%\Studio AI Image\channel.json，也就是用户真实配置。
// 测试若落在这个目录上，本机切到第三方渠道后整组用例会突然变红。
// 这里显式给一个空目录 + 假凭据，把测试和用户环境隔开。
function isolatedChannels(credentialStore) {
  return createChannelStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runtime-')),
    aliyun: credentialStore,
    openai: { read: async () => null, save: async () => {}, clear: async () => {} },
    env: {}
  });
}

test('runtime binds a fresh provider to the configured Beijing workspace for a job', async () => {
  const { createRuntime } = require('../src/main');
  const calls = [];
  const credentialStore = { read: async () => ({ apiKey: 'test-only-key', workspaceId: 'ws_123' }) };
  const server = createRuntime({ credentialStore, channelStore: isolatedChannels(credentialStore), clientToken: 'a'.repeat(43), providerFactory: (config) => {
    calls.push(config);
    return { submit: async () => ({ taskId: 'remote-id' }), poll: async () => ({ status: 'FAILED', resultUrls: [] }) };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/jobs', method: 'POST', headers: { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': 'a'.repeat(43), 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
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

// BFL 是第三种渠道，配置里没有「业务空间」这个概念。server 的统一检查只认
// {apiKey, workspaceId}，如果适配层不给它一个值，选了 BFL 会被判成「没配置」，
// 用户看到的是「请先设置百炼 API Key」——和实际原因完全无关。
test('runtime routes kind=bfl to its own provider and passes the config check', async () => {
  const { createRuntime } = require('../src/main');
  const calls = [];
  const fake = () => {
    let value = null;
    return { read: async () => value, save: async (next) => { value = next; }, clear: async () => { value = null; } };
  };
  const channels = createChannelStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runtime-')),
    aliyun: fake(), openai: fake(), bfl: fake(), env: {}
  });
  await channels.save({ kind: 'bfl', apiKey: 'bfl-test-only', model: 'flux-2-pro-preview' });

  const server = createRuntime({
    credentialStore: fake(),
    channelStore: channels,
    clientToken: 'a'.repeat(43),
    providerFactory: (config) => {
      calls.push(config);
      return { submit: async () => ({ taskId: 'bfl-remote' }), poll: async () => ({ status: 'FAILED', resultUrls: [] }) };
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/jobs', method: 'POST', headers: { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': 'a'.repeat(43), 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify({ operation: 'generate', prompt: 'a vase' }));
    });
    assert.equal(status, 202, 'BFL 没有 workspaceId，也不该被配置检查拦下');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'bfl');
    assert.equal(calls[0].model, 'flux-2-pro-preview');
    assert.equal(calls[0].apiKey, 'bfl-test-only');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
