(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioService = api;
}(this, function () {
  'use strict';

  function createClient(base, Xhr, tokenStore) {
    Xhr = Xhr || XMLHttpRequest;
    base = base || 'http://127.0.0.1:32145';
    tokenStore = tokenStore || (typeof localStorage === 'undefined' ? null : localStorage);
    function request(method, path, body, binary) {
      return new Promise(function (resolve, reject) {
        var xhr = new Xhr();
        xhr.open(method, base + path, true);
        xhr.setRequestHeader('X-STUDIO-Client', 'studio-plugin');
        var token = tokenStore && tokenStore.getItem('studio.clientToken');
        if (token) xhr.setRequestHeader('X-STUDIO-Token', token);
        if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
        if (binary) xhr.responseType = 'arraybuffer';
        xhr.timeout = 30000;
        xhr.onerror = xhr.ontimeout = function () { reject(new Error('无法连接本地服务。点顶部状态条可一键启动。')); };
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
            // 分片长度取 3 的倍数（24576 = 8192×3）：每片单独 btoa 后直接拼 base64，
            // 不必先把整个文件拼成一个等长的二进制大字符串再编码——大图时那一步
            // 会额外占一份与图片同大的内存。最后一片不足 3 字节也没关系，
            // 它本来就是结尾，padding 会落在这里。
            var step = 24576;
            var encoded = '';
            for (var i = 0; i < bytes.length; i += step) {
              encoded += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
            }
            resolve('data:image/png;base64,' + encoded);
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
      // 原图缩小版，只用于「原图 ↔ 生成后」滑块对比。纯生成没有底稿，会 400。
      origin: function (id) { return request('GET', '/v1/jobs/' + encodeURIComponent(id) + '/origin', undefined, true); },
      cancel: function (id) { return request('DELETE', '/v1/jobs/' + encodeURIComponent(id)); },
      // 只重新下载已经生成好的结果图。用于「图出来了但下载失败」——不重新生成、不计费。
      recover: function (id) { return request('POST', '/v1/jobs/' + encodeURIComponent(id) + '/recover'); },
      status: function () { return request('GET', '/v1/settings/status'); },
      saveKey: function (apiKey, workspaceId) { return request('PUT', '/v1/settings/key', { apiKey: apiKey, workspaceId: workspaceId }); },
      channel: function () { return request('GET', '/v1/channel'); },
      saveChannel: function (payload) { return request('PUT', '/v1/channel', payload); },
      // 只测不存：用面板里当前填的值敲一次渠道，确认地址、Key、模型名对得上。
      testChannel: function (payload) { return request('POST', '/v1/channel/test', payload); },
      setToken: function (token) {
        token = String(token || '').trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !tokenStore) throw new Error('请输入本地服务显示的连接码。');
        tokenStore.setItem('studio.clientToken', token);
      },
    };
  }
  return { createClient: createClient };
}));
