const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../js/service-client');

test('CEP client includes the paired local code on later requests', async () => {
  const items = new Map();
  const store = { getItem: (key) => items.get(key), setItem: (key, value) => items.set(key, value) };
  let sent;
  function Xhr() { this.headers = {}; }
  Xhr.prototype.open = function () {};
  Xhr.prototype.setRequestHeader = function (key, value) { this.headers[key] = value; };
  Xhr.prototype.send = function () { sent = this.headers; this.status = 200; this.responseText = '{"configured":false}'; this.onload(); };
  const client = createClient('http://127.0.0.1:32145', Xhr, store);
  client.setToken('a'.repeat(43));
  await client.status();
  assert.equal(sent['X-STUDIO-Token'], 'a'.repeat(43));
});

test('binary results are base64-encoded across chunk boundaries without corruption', async () => {
  // 分片按 3 的倍数切，最后一片单独补 padding。长度不是 3 的倍数、
  // 且跨越好几个分片时最容易出错，所以直接拿 Node 的 base64 结果对照。
  const payload = Buffer.alloc(24576 * 2 + 5);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;
  function Xhr() {}
  Xhr.prototype.open = function () {};
  Xhr.prototype.setRequestHeader = function () {};
  Xhr.prototype.send = function () {
    this.status = 200;
    this.response = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    this.onload();
  };
  const client = createClient('http://127.0.0.1:32145', Xhr, null);
  const dataUrl = await client.result('job', 0);
  assert.equal(dataUrl, 'data:image/png;base64,' + payload.toString('base64'));
});
