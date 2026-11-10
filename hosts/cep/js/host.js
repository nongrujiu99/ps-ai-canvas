(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSAIHost = factory();
}(this, function () {
  'use strict';

  function scriptCall(name, args) {
    if (!/^(inspect|capture|apply|openSeparate)$/.test(name)) throw new Error('Invalid bridge method');
    return 'PSAI.' + name + '(' + args.map(function (arg) { return JSON.stringify(arg); }).join(',') + ')';
  }

  function createHost(options) {
    var cs = options.cs;
    var fs = options.fs;
    var encoding = options.encoding;
    var tempPath = options.tempPath || function () {
      var dir = cs.getSystemPath(SystemPath.USER_DATA).replace(/\//g, '\\');
      return dir + '\\ps-ai-result-' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.png';
    };

    function invoke(name, args) {
      return new Promise(function (resolve, reject) {
        cs.evalScript(scriptCall(name, args || []), function (text) {
          var response;
          try { response = JSON.parse(text); }
          catch (_) { reject(new Error('Photoshop 脚本未返回有效结果。')); return; }
          if (!response.ok) {
            var error = new Error(response.message || 'Photoshop 操作失败。');
            error.code = response.code || 'HOST_ERROR';
            reject(error);
          } else resolve(response.value);
        });
      });
    }

    function readPng(path) {
      var result = fs.readFile(path, encoding.Base64);
      if (!result || result.err !== 0 || typeof result.data !== 'string') throw new Error('无法读取 Photoshop 临时图像。');
      return { kind: 'encoded', dataUrl: 'data:image/png;base64,' + result.data };
    }

    function stage(dataUrl) {
      var match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!match) throw new Error('预览图像不是有效 PNG。');
      var path = tempPath();
      var result = fs.writeFile(path, match[1], encoding.Base64);
      if (!result || result.err !== 0) throw new Error('无法写入 Photoshop 临时图像。');
      return path;
    }

    return {
      inspect: function () { return invoke('inspect'); },
      capture: function (operation, settings) {
        return invoke('capture', [operation, settings || {}]).then(function (value) {
          var captured = false;
          try {
            var image = readPng(value.imagePath);
            var mask = value.maskPath ? readPng(value.maskPath) : null;
            captured = true;
            return { image: image, mask: mask, maskPath: value.maskPath || null, context: value.context };
          } finally {
            fs.deleteFile(value.imagePath);
            if (!captured && value.maskPath) fs.deleteFile(value.maskPath);
          }
        });
      },
      dispose: function (capture) { if (capture && capture.maskPath) fs.deleteFile(capture.maskPath); },
      apply: function (resultPng, capture) {
        var path = stage(resultPng);
        return invoke('apply', [path, capture.context, capture.maskPath || '']).then(function (value) {
          fs.deleteFile(path);
          if (capture.maskPath) fs.deleteFile(capture.maskPath);
          return value;
        }, function (error) { fs.deleteFile(path); if (capture.maskPath) fs.deleteFile(capture.maskPath); throw error; });
      },
      openSeparate: function (resultPng) {
        var path = stage(resultPng);
        return invoke('openSeparate', [path]).then(function (value) { fs.deleteFile(path); return value; }, function (error) { fs.deleteFile(path); throw error; });
      },
    };
  }

  return { createHost: createHost, scriptCall: scriptCall };
}));
