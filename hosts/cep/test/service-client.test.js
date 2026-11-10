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
  assert.equal(sent['X-PSAI-Token'], 'a'.repeat(43));
});
