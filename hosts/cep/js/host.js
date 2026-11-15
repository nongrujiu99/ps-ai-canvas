(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioHost = api;
}(this, function () {
  'use strict';

  function scriptCall(name, args) {
    if (!/^(inspect|capture|apply|openSeparate)$/.test(name)) throw new Error('Invalid bridge method');
    return 'Studio.' + name + '(' + args.map(function (arg) { return JSON.stringify(arg); }).join(',') + ')';
  }

  function createHost(options) {
    var cs = options.cs;
    var fs = options.fs;
    var encoding = options.encoding;
    var bridgeLoaded = false;
    var bridgePath = (function () {
      try {
        var dir = cs.getSystemPath(SystemPath.EXTENSION).replace(/\//g, '\\');
        return dir + '\\jsx\\bridge.jsx';
      } catch (_) { return 'jsx\\bridge.jsx'; }
    }());
    var tempPath = options.tempPath || function () {
      var dir = cs.getSystemPath(SystemPath.USER_DATA).replace(/\//g, '\\');
      return dir + '\\studio-result-' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.png';
    };

    function evalScript(script, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('Photoshop 脚本执行超时。'));
        }, timeoutMs || 60000);
        cs.evalScript(script, function (text) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (text && /^EvalScript_ErrMessage/.test(text)) { reject(new Error('Photoshop 脚本执行失败。')); return; }
          resolve(text);
        });
      });
    }

    // 记住「加载的是哪一版 bridge.jsx」。只缓存「已加载」这个布尔值的话，
    // 改了脚本、面板没重开，跑的还是旧逻辑——排查时会一直在错误的代码上找问题
    // （这个坑已经踩过一次）。用文件 mtime 当版本号，改了脚本下次调用就会自动重载。
    var loadedStamp = null;
    function bridgeStamp() {
      try {
        var info = fs.stat(bridgePath);
        if (!info || info.err !== 0 || !info.data) return null;
        return String(info.data.mtime);
      } catch (_) { return null; }
    }

    function ensureBridge() {
      var stamp = bridgeStamp();
      if (bridgeLoaded && stamp && stamp === loadedStamp) return Promise.resolve();
      var esc = bridgePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return evalScript("$.evalFile(File('" + esc + "')); 'bridge-ok'").then(function () {
        bridgeLoaded = true;
        loadedStamp = stamp;
      }, function () {
        // 若绝对路径加载失败，退回用 #include 相对当前脚本目录加载
        return evalScript("#include 'jsx/bridge.jsx'; 'bridge-ok'").then(function () {
          bridgeLoaded = true;
          loadedStamp = stamp;
        });
      });
    }

    function invoke(name, args, timeoutMs) {
      return ensureBridge().then(function () {
        return evalScript(scriptCall(name, args || []), timeoutMs);
      }).then(function (text) {
        var response;
        try { response = JSON.parse(text); }
        catch (_) { throw new Error('Photoshop 脚本未返回有效结果。'); }
        if (!response.ok) {
          var error = new Error(response.message || 'Photoshop 操作失败。');
          error.code = response.code || 'HOST_ERROR';
          throw error;
        }
        return response.value;
      });
    }

    function readPng(path) {
      var result = fs.readFile(path, encoding.Base64);
      if (!result || result.err !== 0 || typeof result.data !== 'string') throw new Error('无法读取 Photoshop 临时图像。');
      var b64 = String(result.data).replace(/\s+/g, '');
      return { kind: 'encoded', dataUrl: 'data:image/png;base64,' + b64 };
    }

    function stage(dataUrl) {
      var match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
      if (!match) throw new Error('预览图像不是有效 PNG。');
      var path = tempPath();
      var result = fs.writeFile(path, match[1], encoding.Base64);
      if (!result || result.err !== 0) throw new Error('无法写入 Photoshop 临时图像。');
      return path;
    }

    // 控制器不解释预览的结构，原样丢给 host；CEP 这边拿到的是 data URL 字符串，
    // UXP 那边拿到的是 { preview, loadRaw }，这里只负责取出自己需要的部分。
    function dataUrlOf(value) {
      if (typeof value === 'string') return value;
      return value && value.preview;
    }

    return {
      inspect: function () { return invoke('inspect'); },
      capture: function (operation, settings) {
        // 大画布（4000+ 像素宽）导出 PNG 本身就要十几秒，60 秒的默认超时会把
        // 「正在处理」误判成「脚本超时」，而 PS 那边其实还在跑，状态就对不上了。
        return invoke('capture', [operation, settings || {}], 120000).then(function (value) {
          var captured = false;
          try {
            var image = readPng(value.imagePath);
            var mask = value.maskPath ? readPng(value.maskPath) : null;
            captured = true;
            return { image: image, mask: mask, maskPath: value.applyMaskPath || value.maskPath || null, workMaskPath: value.applyMaskPath && value.maskPath !== value.applyMaskPath ? value.maskPath : null, context: value.context };
          } finally {
            fs.deleteFile(value.imagePath);
            if (!captured && value.maskPath) fs.deleteFile(value.maskPath);
            if (!captured && value.applyMaskPath && value.applyMaskPath !== value.maskPath) fs.deleteFile(value.applyMaskPath);
          }
        });
      },
      dispose: function (capture) { if (capture && capture.maskPath) fs.deleteFile(capture.maskPath); if (capture && capture.workMaskPath && capture.workMaskPath !== capture.maskPath) fs.deleteFile(capture.workMaskPath); },
      apply: function (preview, capture) {
        var path = stage(dataUrlOf(preview));
        // skipMaskApply：扩宽模式改用「按透明边推导比例」时没有真正的应用选区，
        // 传空路径让 JSX 侧跳过选区加载，避免在文档里留下多余选区。
        var applyMask = capture.skipMaskApply ? '' : (capture.maskPath || '');
        // 应用要做「打开结果文档 → 复制图层 → 平移对齐 → 必要时改画布」，大图下来
        // 很容易超过 60 秒，而且中途被判定超时会让 PS 留在半截状态。
        return invoke('apply', [path, capture.context, applyMask], 180000).then(function (value) {
          fs.deleteFile(path);
          if (capture.maskPath) fs.deleteFile(capture.maskPath);
          if (capture.workMaskPath) fs.deleteFile(capture.workMaskPath);
          return value;
        }, function (error) { fs.deleteFile(path); if (capture.maskPath) fs.deleteFile(capture.maskPath); if (capture.workMaskPath) fs.deleteFile(capture.workMaskPath); throw error; });
      },
      openSeparate: function (preview) {
        var path = stage(dataUrlOf(preview));
        return invoke('openSeparate', [path]).then(function (value) { fs.deleteFile(path); return value; }, function (error) { fs.deleteFile(path); throw error; });
      },
    };
  }

  return { createHost: createHost, scriptCall: scriptCall };
}));
