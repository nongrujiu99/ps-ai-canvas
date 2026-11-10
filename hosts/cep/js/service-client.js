(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSAIService = factory();
}(this, function () {
  'use strict';

  function createClient(base, Xhr) {
    Xhr = Xhr || XMLHttpRequest;
    base = base || 'http://127.0.0.1:32145';
    function request(method, path, body, binary) {
      return new Promise(function (resolve, reject) {
        var xhr = new Xhr();
        xhr.open(method, base + path, true);
        xhr.setRequestHeader('X-PSAI-Client', 'ps-ai-plugin');
        if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
        if (binary) xhr.responseType = 'arraybuffer';
        xhr.timeout = 30000;
        xhr.onerror = xhr.ontimeout = function () { reject(new Error('无法连接本地服务，请启动 PS AI 本地服务后重试。')); };
        xhr.onload = function () {
          if (xhr.status < 200 || xhr.status >= 300) {
            var data = {};
            try { data = JSON.parse(xhr.responseText); } catch (_) {}
            var error = new Error(data.message || '本地服务请求失败。');
            error.code = data.code || 'SERVICE_ERROR';
            reject(error);
            return;
          }
          if (binary) {
            var bytes = new Uint8Array(xhr.response);
            var chunks = [];
            for (var i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
            resolve('data:image/png;base64,' + btoa(chunks.join('')));
          } else {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch (_) { reject(new Error('本地服务返回了无效数据。')); }
          }
        };
        xhr.send(body === undefined ? null : JSON.stringify(body));
      });
    }
    return {
      inspect: function (capture) { return request('POST', '/v1/inspect', capture); },
      start: function (job) { return request('POST', '/v1/jobs', job); },
      get: function (id) { return request('GET', '/v1/jobs/' + encodeURIComponent(id)); },
      result: function (id, index) { return request('GET', '/v1/results/' + encodeURIComponent(id) + '/' + index, undefined, true); },
      cancel: function (id) { return request('DELETE', '/v1/jobs/' + encodeURIComponent(id)); },
      status: function () { return request('GET', '/v1/settings/status'); },
      saveKey: function (apiKey, workspaceId) { return request('PUT', '/v1/settings/key', { apiKey: apiKey, workspaceId: workspaceId }); },
    };
  }
  return { createClient: createClient };
}));
