'use strict';

const { toBase64 } = require('./imaging-adapter');

function createClient(base = 'http://127.0.0.1:32145', fetchImpl = fetch, tokenStore = (typeof localStorage === 'undefined' ? null : localStorage)) {
  async function request(method, path, body) {
    let response;
    try {
      const token = tokenStore && tokenStore.getItem('studio.clientToken');
      response = await fetchImpl(base + path, { method, headers: { 'X-STUDIO-Client': 'studio-plugin', ...(token ? { 'X-STUDIO-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('无法连接本地服务，请启动 AI 图像工坊 本地服务后重试。'); }
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch {}
      const error = new Error(data.message || '本地服务请求失败。');
      error.code = data.code || 'SERVICE_ERROR';
      throw error;
    }
    return response;
  }
  return {
    inspect: async (capture) => (await request('POST', '/v1/inspect', capture)).json(),
    start: async (job) => (await request('POST', '/v1/jobs', job)).json(),
    get: async (id) => (await request('GET', '/v1/jobs/' + encodeURIComponent(id))).json(),
    cancel: async (id) => (await request('DELETE', '/v1/jobs/' + encodeURIComponent(id))).json(),
    // 只重新下载已经生成好的结果图。用于「图出来了但下载失败」——不重新生成、不计费。
    recover: async (id) => (await request('POST', '/v1/jobs/' + encodeURIComponent(id) + '/recover')).json(),
    status: async () => (await request('GET', '/v1/settings/status')).json(),
    saveKey: async (apiKey, workspaceId) => (await request('PUT', '/v1/settings/key', { apiKey, workspaceId })).json(),
    channel: async () => (await request('GET', '/v1/channel')).json(),
    saveChannel: async (payload) => (await request('PUT', '/v1/channel', payload)).json(),
    // 只测不存：用面板里当前填的值敲一次渠道，确认地址、Key、模型名对得上。
    testChannel: async (payload) => (await request('POST', '/v1/channel/test', payload)).json(),
    setToken: (token) => {
      token = String(token || '').trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !tokenStore) throw new Error('请输入本地服务显示的连接码。');
      tokenStore.setItem('studio.clientToken', token);
    },
    result: async (id, index) => {
      const path = '/v1/results/' + encodeURIComponent(id) + '/' + index;
      const png = new Uint8Array(await (await request('GET', path)).arrayBuffer());
      // 预览只取 PNG。RGBA 是同图的 4 倍体积，而且只有「点应用的那一张」需要，
      // 以前每个候选都立刻取两份，多候选时等于把几 MB 数据翻倍传。
      // 这里把 RGBA 做成惰性加载，取过一次就缓存（重试应用时不会重复下载）。
      let cached = null;
      const loadRaw = async () => {
        if (cached) return cached;
        const response = await request('GET', path + '/raw');
        const width = Number(response.headers.get('X-Image-Width'));
        const height = Number(response.headers.get('X-Image-Height'));
        const data = new Uint8Array(await response.arrayBuffer());
        if (!Number.isInteger(width) || !Number.isInteger(height) || data.length !== width * height * 4) throw new Error('本地结果像素无效。');
        cached = { data, width, height };
        return cached;
      };
      return { preview: 'data:image/png;base64,' + toBase64(png), loadRaw };
    },
    // 原图缩小版，只用于「原图 ↔ 生成后」滑块对比。UXP 抓图给的是裸 RGBA，
    // 前端没有 PNG 编码器，所以由服务端在提交时压好一张回给这里。
    // 纯生成没有底稿，服务端会明确拒绝，控制器那边当作「没有对比图」处理。
    origin: async (id) => {
      const response = await request('GET', '/v1/jobs/' + encodeURIComponent(id) + '/origin');
      const png = new Uint8Array(await response.arrayBuffer());
      return 'data:image/png;base64,' + toBase64(png);
    },
  };
}

module.exports = { createClient };
