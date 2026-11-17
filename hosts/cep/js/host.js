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

    // 遮罩在 JS 侧生成，不再经过 Photoshop。背景全黑、选区矩形填白，
    // 格式与 UXP 的 getSelection 一致（gray8 原始字节），服务端 decodeOne 早已支持。
    // 关键：选区坐标是「整张画布」系的，抓图可能被 workArea 裁剪过，
    // 因此要减去裁剪原点，并裁掉落在图外的部分，否则遮罩和图像对不上。
    function maskFromContext(context) {
      if (!context || !context.selectionBounds) return null;
      var bounds = context.selectionBounds;
      var work = context.workArea || { left: 0, top: 0, right: context.width, bottom: context.height };
      var width = Math.max(1, work.right - work.left);
      var height = Math.max(1, work.bottom - work.top);
      var left = Math.max(0, Math.round(bounds.left - work.left));
      var top = Math.max(0, Math.round(bounds.top - work.top));
      var right = Math.min(width, Math.round(bounds.right - work.left));
      var bottom = Math.min(height, Math.round(bounds.bottom - work.top));
      if (right <= left || bottom <= top) return null;
      var bytes = new Uint8Array(width * height);
      for (var y = top; y < bottom; y++) {
        for (var x = left; x < right; x++) bytes[y * width + x] = 255;
      }
      return { kind: 'gray8', width: width, height: height, dataBase64: bytesToBase64(bytes) };
    }

    function bytesToBase64(bytes) {
      var out = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(out);
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
            var mask = maskFromContext(value.context);
            captured = true;
            return { image: image, mask: mask, maskPath: null, context: value.context };
          } finally {
            fs.deleteFile(value.imagePath);
          }
        });
      },
      dispose: function (capture) { /* 遮罩已不在磁盘上，无需清理 */ },
      apply: function (preview, capture) {
        var path = stage(dataUrlOf(preview));
        // 选区坐标随 context 一起交给 JSX，由它在应用阶段重建选区并建蒙版。
        return invoke('apply', [path, capture.context, ''], 180000).then(function (value) {
          fs.deleteFile(path);
          return value;
        }, function (error) { fs.deleteFile(path); throw error; });
      },
      openSeparate: function (preview) {
        var path = stage(dataUrlOf(preview));
        return invoke('openSeparate', [path]).then(function (value) { fs.deleteFile(path); return value; }, function (error) { fs.deleteFile(path); throw error; });
      },
    };
  }

  return { createHost: createHost, scriptCall: scriptCall };
}));
