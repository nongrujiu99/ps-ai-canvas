'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { problem } = require('./contract');

const scriptPath = path.join(__dirname, '..', 'scripts', 'wincred.ps1');

function runPowerShell(operation, input = '', target = 'Studio.AiImg.Bailian') {
  return new Promise((resolve, reject) => {
    // 一定要显式传 -Target：凭据库里现在有两个条目（百炼 / 第三方），
    // 不传 target 时脚本会回落到默认的百炼条目，第三方 Key 就会被写到百炼头上。
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, operation, '-Target', target], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('credential helper failed')));
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(stdout).toString('utf8').trim()) : reject(new Error('credential helper failed')));
    child.stdin.end(input);
  });
}

function createCredentialStore({ run = runPowerShell, platform = process.platform, target = 'Studio.AiImg.Bailian' } = {}) {
  // 凭据读写完全依赖 Windows 凭据管理器（wincred.ps1）。在 macOS 上继续跑只会
  // 在 spawn 失败后抛一句「无法读取凭据」，用户会以为是 Key 配错了。
  // 直接把限制说清楚，比让他去翻日志强。
  const unsupported = platform !== 'win32'
    ? problem('UNSUPPORTED_OS', '本地服务目前只支持 Windows：API Key 保存在 Windows 凭据管理器。')
    : null;
  return {
    async read() {
      if (unsupported) throw unsupported;
      try {
        const value = await run('read', '', target);
        if (!value) return null;
        const data = JSON.parse(value);
        if (!data || typeof data.apiKey !== 'string' || typeof data.workspaceId !== 'string') throw new Error('invalid credential');
        return { apiKey: data.apiKey, workspaceId: data.workspaceId };
      } catch {
        throw problem('CREDENTIAL_READ', '无法读取当前用户的 API 凭据。');
      }
    },
    async save(settings) {
      if (unsupported) throw unsupported;
      try {
        await run('write', JSON.stringify({ apiKey: settings.apiKey, workspaceId: settings.workspaceId }), target);
      } catch {
        throw problem('CREDENTIAL_WRITE', '无法保存 API 凭据。');
      }
    },
    async clear() {
      if (unsupported) throw unsupported;
      try { await run('delete', '', target); }
      catch { throw problem('CREDENTIAL_DELETE', '无法删除 API 凭据。'); }
    },
  };
}

module.exports = { createCredentialStore };
