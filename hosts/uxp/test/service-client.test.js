const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../src/service-client');

test('UXP result client fetches preview PNG and full raw pixels from loopback', async () => {
  const paths = [];
  const fetchImpl = async (url, init) => {
    paths.push([url, init.headers['X-PSAI-Client']]);
    if (url.endsWith('/raw')) return new Response(Uint8Array.from([1, 2, 3, 255]), { headers: { 'X-Image-Width': '1', 'X-Image-Height': '1' } });
    return new Response(Uint8Array.from([137, 80, 78, 71]));
  };
  const result = await createClient('http://127.0.0.1:32145', fetchImpl).result('job', 0);
  assert.match(result.preview, /^data:image\/png;base64,/);
  assert.deepEqual([...result.raw.data], [1, 2, 3, 255]);
  assert.equal(result.raw.width, 1);
  assert.equal(paths.length, 2);
  assert.equal(paths[0][1], 'ps-ai-plugin');
});
