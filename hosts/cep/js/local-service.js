(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioLocalService = api;
}(this, function () {
  'use strict';

  // 面板负责把本地服务拉起来，用户不再需要开终端、不再需要抄连接码。
  //
  // 为什么这件事只能在 CEP 做：CEP 清单里开了 --enable-nodejs + --mixed-context，
  // 面板里有 fs / child_process；UXP 沙箱既不允许 create process，也读不了
  // %LOCALAPPDATA% 下的文件，所以 UXP 端仍然是手工填码。
  //
  // 为什么不在面板里直接跑服务：CEP 内嵌的 Node 是 8.x（PS 2018），而服务用了
  // node: 前缀、AbortSignal.timeout、全局 fetch，跑不起来。必须拉起独立的
  // node.exe（绿色包里的 runtime/node.exe，或开发机 PATH 里的 node）。

  function nodeRequire(name) {
    try { return typeof require === 'function' ? require(name) : null; } catch (error) { return null; }
  }

  // 连接码由服务生成并落盘（权限 0600），面板读同一份文件即可——和手工抄写
  // 是同一个授权边界：都是「能读当前用户 profile 的进程」。少一步粘贴，不降安全。
  function defaultDataDir(fs, path, env) {
    var home = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '');
    return home ? path.join(home, 'Studio AI Image') : '';
  }

  function createLauncher(options) {
    options = options || {};
    var fs = options.fs || nodeRequire('fs');
    var path = options.path || nodeRequire('path');
    var spawn = options.spawn || (function () {
      var childProcess = options.childProcess || nodeRequire('child_process');
      return childProcess && childProcess.spawn;
    }());
    var Xhr = options.Xhr || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
    var env = options.env || (typeof process !== 'undefined' && process.env) || {};
    var base = String(options.base || 'http://127.0.0.1:32145').replace(/\/+$/, '');
    var extRoot = options.extRoot || '';
    var dataDir = options.dataDir || (fs && path ? defaultDataDir(fs, path, env) : '');
    var tokenPath = options.tokenPath || (path && dataDir ? path.join(dataDir, 'client-token') : '');
    var logPath = options.logPath || (path && dataDir ? path.join(dataDir, 'service.log') : '');
    // 这几个值都允许显式传 0（测试里要「立刻超时」）。用 || 会让 0 悄悄回落到默认值，
    // 表现为测试跑了 30 秒才过——踩过一次，这里显式判 undefined。
    function numberOption(value, fallback) { return value === undefined ? fallback : Number(value); }
    var probeTimeoutMs = numberOption(options.probeTimeoutMs, 1500);
    var startTimeoutMs = numberOption(options.startTimeoutMs, 30000);
    var pollIntervalMs = numberOption(options.pollIntervalMs, 300);
    var wait = options.wait || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };

    var launcherCache = null;
    var launcherLooked = false;

    function readToken() {
      if (!fs || !tokenPath) return null;
      try {
        var token = String(fs.readFileSync(tokenPath, 'utf8')).trim();
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
      } catch (error) {
        return null;
      }
    }

    // /health 在服务里是免鉴权的（鉴权在它之后），所以能用它判活，不需要先有码。
    function probe() {
      if (!Xhr) return Promise.resolve(false);
      return new Promise(function (resolve) {
        var xhr = new Xhr();
        try { xhr.open('GET', base + '/health', true); } catch (error) { resolve(false); return; }
        xhr.timeout = probeTimeoutMs;
        xhr.onload = function () {
          try { resolve(JSON.parse(xhr.responseText).status === 'ok'); } catch (error) { resolve(false); }
        };
        xhr.onerror = xhr.ontimeout = function () { resolve(false); };
        try { xhr.send(null); } catch (error) { resolve(false); }
      });
    }

    // 启动参数来自安装时写入的 service-path.json，相对路径按扩展根解析。
    // 换成绿色包时这个文件指向包内的 runtime/node.exe 与 service/src/main.js；
    // 开发安装时指向项目目录和系统 node，面板不用改一行。
    function launcherConfig() {
      if (launcherLooked) return launcherCache;
      launcherLooked = true;
      if (!fs || !path || !extRoot) return null;
      var file = path.join(extRoot, 'service-path.json');
      try {
        var config = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!config || !config.node || !config.entry) return null;
        var resolve = function (value) {
          value = String(value);
          return path.isAbsolute(value) ? value : path.join(extRoot, value);
        };
        launcherCache = {
          node: resolve(config.node),
          entry: resolve(config.entry),
          cwd: config.cwd ? resolve(config.cwd) : path.dirname(resolve(config.entry))
        };
      } catch (error) {
        launcherCache = null;
      }
      return launcherCache;
    }

    function canLaunch() { return Boolean(spawn); }

    function spawnService() {
      var config = launcherConfig();
      if (!config || !spawn) return null;
      var stdio = 'ignore';
      var out = null;
      // 服务的失败日志（[job xxx] failed CODE ...）是排查的唯一线索，
      // 面板拉起的进程没有窗口，所以把 stdout/stderr 落到文件里。
      if (fs && logPath) {
        try { out = fs.openSync(logPath, 'a'); stdio = ['ignore', out, out]; } catch (error) { out = null; }
      }
      try {
        var child = spawn(config.node, [config.entry], {
          cwd: config.cwd,
          detached: true,      // PS 关掉后服务继续跑，下次开面板直接连上
          stdio: stdio,
          windowsHide: true
        });
        if (child && typeof child.unref === 'function') child.unref();
        return child;
      } catch (error) {
        return null;
      } finally {
        // stdio 是文件描述符时，父进程这侧要关掉，否则句柄会一直占着日志文件。
        if (out !== null) { try { fs.closeSync(out); } catch (error) {} }
      }
    }

    function failure(code, message) {
      var error = new Error(message);
      error.code = code;
      return error;
    }

    // 探活 → 必要时拉起 → 等到 /health 就绪 → 读出连接码。
    // 已经是活的不重启：用户在 PS 里装着面板，服务可能早就在跑。
    function ensure(onStage) {
      var stage = onStage || function () {};
      return probe().then(function (alive) {
        if (alive) return { started: false };
        var config = launcherConfig();
        if (!config) {
          throw failure('NO_LAUNCHER', '找不到本地服务的启动配置，请重新安装扩展。');
        }
        if (!spawn) {
          throw failure('NO_NODE', '当前面板没有启动进程的权限，请手动运行本地服务。');
        }
        stage('starting');
        var child = spawnService();
        if (!child) throw failure('LAUNCH_FAILED', '无法启动本地服务，请检查扩展目录是否完整。');
        var deadline = Date.now() + startTimeoutMs;
        return (function poll() {
          return probe().then(function (up) {
            if (up) return { started: true };
            if (Date.now() >= deadline) {
              throw failure('LAUNCH_TIMEOUT', '本地服务启动超时，请查看 ' + (logPath || '服务日志') + '。');
            }
            return wait(pollIntervalMs).then(poll);
          });
        }());
      }).then(function (result) {
        var token = readToken();
        if (!token) {
          throw failure('NO_TOKEN', '服务已启动，但读不到连接码，请在设置页手动填写。');
        }
        result.token = token;
        return result;
      });
    }

    return {
      readToken: readToken,
      probe: probe,
      ensure: ensure,
      canLaunch: canLaunch,
      launcherConfig: launcherConfig,
      tokenPath: function () { return tokenPath; },
      logPath: function () { return logPath; }
    };
  }

  return { createLauncher: createLauncher };
}));
