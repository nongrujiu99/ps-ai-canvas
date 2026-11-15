const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../src/service-client');

test('UXP result client fetches the preview PNG first and raw pixels only on demand', async () => {
  const paths = [];
  const fetchImpl = async (url, init) => {
    paths.push([url, init.headers['X-STUDIO-Client']]);
    if (url.endsWith('/raw')) return new Response(Uint8Array.from([1, 2, 3, 255]), { headers: { 'X-Image-Width': '1', 'X-Image-Height': '1' } });
    return new Response(Uint8Array.from([137, 80, 78, 71]));
  };
  const result = await createClient('http://127.0.0.1:32145', fetchImpl).result('job', 0);
  assert.match(result.preview, /^data:image\/png;base64,/);
  // 预览阶段只下载 PNG：多候选时不必把所有候选的 RGBA 一起拉下来。
  assert.equal(paths.length, 1);
  assert.equal(paths[0][1], 'studio-plugin');
  const raw = await result.loadRaw();
  assert.deepEqual([...raw.data], [1, 2, 3, 255]);
  assert.equal(raw.width, 1);
  assert.equal(paths.length, 2);
  // 再取一次走缓存，不重复下载。
  await result.loadRaw();
  assert.equal(paths.length, 2);
});

test('UXP client includes the paired local code on later requests', async () => {
  const items = new Map();
  const store = { getItem: (key) => items.get(key), setItem: (key, value) => items.set(key, value) };
  let sent;
  const fetchImpl = async (_url, init) => { sent = init.headers; return new Response(JSON.stringify({ configured: false }), { headers: { 'content-type': 'application/json' } }); };
  const client = createClient('http://127.0.0.1:32145', fetchImpl, store);
  client.setToken('a'.repeat(43));
  await client.status();
  assert.equal(sent['X-STUDIO-Token'], 'a'.repeat(43));
});
