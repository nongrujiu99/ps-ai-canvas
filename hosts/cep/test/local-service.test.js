'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLauncher } = require('../js/local-service');

const TOKEN = 'a'.repeat(43);

// 假 XHR：按脚本依次给出「连上 / 连不上」，避免测试里真的开端口。
function xhrSequence(steps) {
  let index = 0;
  function Xhr() {}
  Xhr.prototype.open = function (method, url) { this.url = url; };
  Xhr.prototype.send = function () {
    const self = this;
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    setImmediate(() => {
      if (step === 'up') { self.status = 200; self.responseText = '{"status":"ok"}'; self.onload(); }
      else { self.onerror(); }
    });
  };
  return Xhr;
}

function fakeFs(files) {
  return {
    readFileSync(file) {
      if (!(file in files)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files[file];
    },
    openSync() { return 3; },
    closeSync() {},
  };
}

function makeLauncher(overrides = {}) {
  const extRoot = 'C:\\ext';
  const spawned = [];
  const launcher = createLauncher(Object.assign({
    fs: fakeFs({
      [path.join(extRoot, 'service-path.json')]: JSON.stringify({ node: 'runtime\\node.exe', entry: 'service\\src\\main.js', cwd: 'service' }),
      ['C:\\data\\client-token']: TOKEN,
    }),
    path,
    spawn: (command, args, options) => { spawned.push({ command, args, options }); return { unref() {} }; },
    Xhr: xhrSequence(['down']),
    env: {},
    extRoot,
    dataDir: 'C:\\data',
    tokenPath: 'C:\\data\\client-token',
    logPath: 'C:\\data\\service.log',
    wait: () => Promise.resolve(),
    pollIntervalMs: 1,
    startTimeoutMs: 50,
  }, overrides));
  return { launcher, spawned };
}

test('reads the connection code the service already wrote to disk', () => {
  const { launcher } = makeLauncher();
  assert.equal(launcher.readToken(), TOKEN);
});

test('a malformed token file is treated as missing instead of being sent as-is', () => {
  const { launcher } = makeLauncher({ fs: fakeFs({ ['C:\\data\\client-token']: 'too-short' }) });
  assert.equal(launcher.readToken(), null);
});

test('an already running service is reused instead of being started twice', async () => {
  const { launcher, spawned } = makeLauncher({ Xhr: xhrSequence(['up']) });
  const result = await launcher.ensure();
  assert.equal(result.started, false);
  assert.equal(result.token, TOKEN);
  assert.equal(spawned.length, 0);
});

test('a stopped service is launched with the configured node and entry', async () => {
  // 第一次探活失败，拉起后再探活成功。
  const { launcher, spawned } = makeLauncher({ Xhr: xhrSequence(['down', 'down', 'up']) });
  const result = await launcher.ensure();
  assert.equal(result.started, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, path.join('C:\\ext', 'runtime\\node.exe'));
  assert.equal(spawned[0].args[0], path.join('C:\\ext', 'service\\src\\main.js'));
  assert.equal(spawned[0].options.cwd, path.join('C:\\ext', 'service'));
  // detached 是「关掉 PS 服务还在跑」的前提，否则下次开面板又要重启一次。
  assert.equal(spawned[0].options.detached, true);
});

test('a service that never answers surfaces a timeout instead of hanging forever', async () => {
  const { launcher } = makeLauncher({ Xhr: xhrSequence(['down']), startTimeoutMs: 0 });
  await assert.rejects(() => launcher.ensure(), (error) => {
    assert.equal(error.code, 'LAUNCH_TIMEOUT');
    assert.match(error.message, /超时/);
    return true;
  });
});

test('a missing launcher config explains what to do instead of spawning nothing', async () => {
  const { launcher, spawned } = makeLauncher({ fs: fakeFs({ ['C:\\data\\client-token']: TOKEN }) });
  await assert.rejects(() => launcher.ensure(), (error) => {
    assert.equal(error.code, 'NO_LAUNCHER');
    assert.match(error.message, /重新安装/);
    return true;
  });
  assert.equal(spawned.length, 0);
});

test('absolute paths in the launcher config are used as-is (green bundle points inside the extension)', () => {
  const { launcher } = makeLauncher({
    fs: fakeFs({
      ['C:\\ext\\service-path.json']: JSON.stringify({ node: 'D:\\studio\\runtime\\node.exe', entry: 'D:\\studio\\service\\src\\main.js' }),
      ['C:\\data\\client-token']: TOKEN,
    }),
  });
  const config = launcher.launcherConfig();
  assert.equal(config.node, 'D:\\studio\\runtime\\node.exe');
  assert.equal(config.entry, 'D:\\studio\\service\\src\\main.js');
  assert.equal(config.cwd, 'D:\\studio\\service\\src');
});

test('a running service with an unreadable token reports it rather than connecting anonymously', async () => {
  const { launcher } = makeLauncher({ fs: fakeFs({}), Xhr: xhrSequence(['up']) });
  await assert.rejects(() => launcher.ensure(), (error) => {
    assert.equal(error.code, 'NO_TOKEN');
    return true;
  });
});
