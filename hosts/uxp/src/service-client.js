'use strict';

const { toBase64 } = require('./imaging-adapter');

function createClient(base = 'http://127.0.0.1:32145', fetchImpl = fetch) {
  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(base + path, { method, headers: { 'X-PSAI-Client': 'ps-ai-plugin', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('无法连接本地服务，请启动 PS AI 本地服务后重试。'); }
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
    status: async () => (await request('GET', '/v1/settings/status')).json(),
    saveKey: async (apiKey, workspaceId) => (await request('PUT', '/v1/settings/key', { apiKey, workspaceId })).json(),
    result: async (id, index) => {
      const path = '/v1/results/' + encodeURIComponent(id) + '/' + index;
      const png = new Uint8Array(await (await request('GET', path)).arrayBuffer());
      const rawResponse = await request('GET', path + '/raw');
      const width = Number(rawResponse.headers.get('X-Image-Width'));
      const height = Number(rawResponse.headers.get('X-Image-Height'));
      const data = new Uint8Array(await rawResponse.arrayBuffer());
      if (!Number.isInteger(width) || !Number.isInteger(height) || data.length !== width * height * 4) throw new Error('本地结果像素无效。');
      return { preview: 'data:image/png;base64,' + toBase64(png), raw: { data, width, height } };
    },
  };
}

module.exports = { createClient };
