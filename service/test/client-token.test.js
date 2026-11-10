const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadClientToken } = require('../src/client-token');

test('a private local connection code is generated once and survives service restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'psai-token-'));
  try {
    const file = path.join(directory, 'client-token');
    const first = loadClientToken(file);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(loadClientToken(file), first);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
