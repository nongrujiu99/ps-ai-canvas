'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { problem } = require('./contract');

const scriptPath = path.join(__dirname, '..', 'scripts', 'wincred.ps1');

function runPowerShell(operation, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, operation], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('credential helper failed')));
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(stdout).toString('utf8').trim()) : reject(new Error('credential helper failed')));
    child.stdin.end(input);
  });
}

function createCredentialStore({ run = runPowerShell } = {}) {
  return {
    async read() {
      try {
        const value = await run('read');
        if (!value) return null;
        const data = JSON.parse(value);
        if (!data || typeof data.apiKey !== 'string' || typeof data.workspaceId !== 'string') throw new Error('invalid credential');
        return { apiKey: data.apiKey, workspaceId: data.workspaceId };
      } catch {
        throw problem('CREDENTIAL_READ', '无法读取当前用户的百炼凭据。');
      }
    },
    async save(settings) {
      try {
        await run('write', JSON.stringify({ apiKey: settings.apiKey, workspaceId: settings.workspaceId }));
      } catch {
        throw problem('CREDENTIAL_WRITE', '无法保存百炼凭据。');
      }
    },
    async clear() {
      try { await run('delete'); }
      catch { throw problem('CREDENTIAL_DELETE', '无法删除百炼凭据。'); }
    },
  };
}

module.exports = { createCredentialStore };
