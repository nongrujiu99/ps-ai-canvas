const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCredentialStore } = require('../src/credential-store');

test('Windows credential helper compiles and can read', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(__dirname, '..', 'scripts', 'wincred.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'read'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test('Windows Credential Manager round-trips a disposable test credential', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(__dirname, '..', 'scripts', 'wincred.ps1');
  const target = `PSAI.Canvas.Test.${randomUUID()}`;
  const run = (operation, input = '') => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, operation, '-Target', target], { input, encoding: 'utf8', windowsHide: true });
  try {
    const write = run('write', 'test-credential-非生产');
    assert.equal(write.status, 0, write.stderr);
    const read = run('read');
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, 'test-credential-非生产');
  } finally {
    const deletion = run('delete');
    assert.equal(deletion.status, 0, deletion.stderr);
  }
  const afterDelete = run('read');
  assert.equal(afterDelete.status, 0, afterDelete.stderr);
  assert.equal(afterDelete.stdout, '');
});

test('saving and reading settings round-trips without changing the public status shape', async () => {
  let saved = '';
  const run = async (operation, input) => {
    if (operation === 'write') { saved = input; return ''; }
    if (operation === 'read') return saved;
    if (operation === 'delete') { saved = ''; return ''; }
    throw new Error('unexpected operation');
  };
  const store = createCredentialStore({ run });
  await store.save({ apiKey: 'sk-test-only', workspaceId: 'workspace_1' });
  assert.deepEqual(await store.read(), { apiKey: 'sk-test-only', workspaceId: 'workspace_1' });
  await store.clear();
  assert.equal(await store.read(), null);
});

test('invalid stored content and runner errors never include the raw key in exceptions', async () => {
  const corrupt = createCredentialStore({ run: async () => '{invalid-json' });
  await assert.rejects(corrupt.read(), { code: 'CREDENTIAL_READ' });
  const failing = createCredentialStore({ run: async () => { throw new Error('sk-secret was rejected'); } });
  await assert.rejects(failing.save({ apiKey: 'sk-secret', workspaceId: 'workspace' }), (error) => error.code === 'CREDENTIAL_WRITE' && !error.message.includes('sk-secret'));
});
