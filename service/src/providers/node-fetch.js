'use strict';

// 一个「够用就好」的 HTTP 客户端，只为 BFL 准备。
//
// 为什么不用全局 fetch：Node 的 fetch 是 undici，走 --use-env-proxy 时用的是
// **实验性**的 EnvHttpProxyAgent。实测（2026-11-14，本机 Clash 6893）：
//   提交请求 → 响应头正常到达（HTTP 200）→ body 永远读不到 → 整个请求挂死，
//   连 AbortController 和 setTimeout 都不再触发，面板上的表现是「测试中…」永不结束。
// 同一时刻 curl（读同样的 HTTPS_PROXY、同样的 CONNECT 隧道）2 秒拿到完整 body。
//
// 所以这里直接按 curl 的方式做：CONNECT 隧道 + 原生 https。好处是
// 超时、代理、body 读取全在一个函数里，没有第三方抽象层挡在中间；
// 代价是要自己写 ~120 行，且只支持 http 代理（socks 不支持——那种情况会
// 退回直连，报错信息会告诉用户开 TUN）。
//
// 返回形状只覆盖用到的子集：{ ok, status, headers, text(), arrayBuffer() }。
// body 在返回前一次性读完，所以 text() 立刻 settle——不存在「读到一半挂住」。

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

function proxyFromEnv(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  // socks 代理没法用 CONNECT 拼出来，硬做只会得到更难懂的错误。
  // 返回 null 让请求走直连，失败时由上层提示「开 TUN」。
  if (url.protocol !== 'http:') return null;
  return { host: url.hostname, port: Number(url.port || 80), auth: url.username ? decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password) : '' };
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.on('aborted', () => reject(Object.assign(new Error('响应被中断'), { code: 'ECONNRESET' })));
  });
}

async function rawRequest(target, { method = 'GET', headers = {}, body, timeoutMs = 45000, env = process.env } = {}) {
  const url = new URL(target);
  const isHttps = url.protocol === 'https:';
  const port = Number(url.port || (isHttps ? 443 : 80));
  const path = url.pathname + url.search;
  const payload = body === undefined || body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  const proxy = proxyFromEnv(env);

  return new Promise((resolve, reject) => {
    let settled = false;
    let activeReq = null;
    let activeSocket = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (error) => finish(reject, error);

    const timer = setTimeout(() => {
      const error = new Error('请求超时');
      error.code = 'ETIMEDOUT_SELF';
      fail(error);
      // 超时后主动断开：否则 socket 会一直占着，重试也拿不到新连接。
      try { if (activeReq) activeReq.destroy(); } catch { /* 已关闭 */ }
      try { if (activeSocket) activeSocket.destroy(); } catch { /* 已关闭 */ }
    }, timeoutMs);
    timer.unref();

    const send = (socketOrNull) => {
      const base = {
        host: url.hostname,
        port,
        path,
        method,
        headers: Object.assign({}, headers, payload ? { 'Content-Length': String(payload.length) } : {}),
        agent: false
      };
      // 隧道已经建好时，让 https 直接复用这条 TLS 连接，不要再自己连一次。
      if (socketOrNull) base.createConnection = () => socketOrNull;
      const mod = isHttps ? https : http;
      activeReq = mod.request(base, (res) => {
        readAll(res).then(
          (buffer) => finish(resolve, { status: res.statusCode, headers: res.headers, buffer }),
          (error) => fail(error)
        );
      });
      activeReq.on('error', fail);
      if (payload) activeReq.write(payload);
      activeReq.end();
    };

    if (!proxy) {
      send(null);
      return;
    }

    const connectHeaders = { host: url.hostname + ':' + port };
    if (proxy.auth) connectHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
    const tunneling = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: url.hostname + ':' + port,
      headers: connectHeaders,
      agent: false
    });
    activeReq = tunneling;
    tunneling.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        try { socket.destroy(); } catch { /* 已关闭 */ }
        fail(Object.assign(new Error('代理拒绝建立隧道（HTTP ' + res.statusCode + '）'), { code: 'EPROXYCONNECT', proxyStatus: res.statusCode }));
        return;
      }
      if (!isHttps) {
        activeSocket = socket;
        send(socket);
        return;
      }
      const secured = tls.connect({ socket, servername: url.hostname });
      activeSocket = secured;
      secured.on('error', fail);
      secured.on('secureConnect', () => send(secured));
    });
    tunneling.on('error', fail);
    tunneling.end();
  });
}

// 包成 fetch 的子集，好让 provider 那边的调用方式保持不变。
function createNodeFetch({ env = process.env } = {}) {
  return async function nodeFetch(url, init = {}) {
    const headers = init.headers || {};
    const { status, headers: resHeaders, buffer } = await rawRequest(url, {
      method: init.method || 'GET',
      headers,
      body: init.body,
      // 这里的超时是兜底。上层（provider）还有自己的定时器，两边都到才算失败。
      timeoutMs: init.timeoutMs,
      env
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => {
          const key = String(name).toLowerCase();
          const value = resHeaders[key];
          return Array.isArray(value) ? value.join(', ') : (value === undefined ? null : value);
        }
      },
      // body 已经读完，这两句都是同步回值的 promise，不会挂住。
      text: async () => buffer.toString('utf8'),
      arrayBuffer: async () => buffer,
      bytes: async () => buffer
    };
  };
}

module.exports = { createNodeFetch, rawRequest, proxyFromEnv };
