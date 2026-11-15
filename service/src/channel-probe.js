'use strict';

const https = require('node:https');
const { normalizeBaseUrl } = require('./providers/openai-compat');
const { isVertexChannel, vertexGenerateUrl, PROBE_MODEL: VERTEX_PROBE_MODEL, classifyNetError, connectHint } = require('./providers/vertex');
const { isBflChannel, bflRoot, DEFAULT_TEXT_MODEL: BFL_DEFAULT_MODEL } = require('./providers/bfl');
const { createNodeFetch } = require('./providers/node-fetch');
const { problem } = require('./contract');

// 「测试连通」只做一件事：拿地址和 Key 去敲渠道的 GET /models。
//
// 为什么不直接生成一张 1:1 的小图来测？因为那是付费且 30 秒起步的操作，
// 用户点「测试」的意图是「我填的这几项对不对」，不是「再出一张图」。
// /models 能同时回答三个问题：地址对不对、Key 有没有效、模型名在不在列表里。
//
// 代价要说清楚：列表里有这个名字，只代表渠道认得这个 ID，不代表它此刻能出图
// （限流、余额、该模型临时下线都不会体现在这里）。所以面板文案写「连通正常」，
// 不写「可以生成」。
const DEFAULT_TIMEOUT_MS = 15000;
// 渠道列几十上百个模型，全塞进面板没法读。只挑名字像图生图的，用来在「模型不在列表里」
// 时给用户几个能直接改的候选——这比一句「名字可能拼错了」有用得多。
const IMAGE_HINT = /image|imagine|dall|flux|seedream|seededit|banana|kolors|sd[-_]?\d|midjourney|mj/i;

function causeCode(error) {
  let node = error;
  // Node 把真实原因藏在 error.cause 链里，最多挖四层，防止环形引用。
  for (let depth = 0; node && depth < 4; depth++) {
    if (node.code) return String(node.code);
    node = node.cause;
  }
  return '';
}

function isTimeout(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return /UND_ERR_CONNECT_TIMEOUT/i.test(causeCode(error));
}

// 只做握手，不发 HTTP 请求：把「DNS / TCP / TLS」三段分别计时。
//
// 为什么值得多花这几十毫秒：代理软件的节点好坏，在 fetch 里只表现为一个总的 latencyMs，
// 分不清是「Google 排队」还是「本机线路慢」。实测同一条线路会出现 DNS 1.4s、TLS 3.3s，
// 这种数字摆在面板上，用户立刻知道今晚这条线值不值得拿去出 4K 图。
//
// 拿到 secureConnect 就 destroy，不产生请求体，也不消耗配额。
function handshakeTimings(baseUrl, timeoutMs = 3500) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(String(baseUrl || '')); } catch { return resolve(null); }
    if (url.protocol !== 'https:') return resolve(null);

    const started = Date.now();
    const marks = {};
    let settled = false;
    let req = null;
    let guard = null;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      try { if (req) req.destroy(); } catch { /* 已经断了 */ }
      resolve({ dnsMs: marks.dns ?? null, tcpMs: marks.tcp ?? null, tlsMs: marks.tls ?? null, ...extra });
    };

    // https.request 的 timeout 只管**连接阶段**，DNS 解析（getaddrinfo）不受它约束。
    // 实测：国内网络查 api.bfl.ai 时，这一步能挂住几十秒，而整次连通测试就卡死在这里——
    // 探针本体 2 秒就拿到 body 了，用户看到的却是「测试中…」永不结束。
    // 所以必须自己兜一道硬超时：宁可说「握手没测成」，也不能把整个测试拖死。
    guard = setTimeout(() => finish({ code: 'HANDSHAKE_TIMEOUT' }), timeoutMs + 1000);

    try {
      req = https.request({
        host: url.hostname,
        port: url.port || 443,
        path: '/',
        method: 'HEAD',
        headers: { Connection: 'close' },
        timeout: timeoutMs
      });
    } catch (error) {
      return finish({ code: causeCode(error) || 'HANDSHAKE_FAILED' });
    }

    req.on('socket', (socket) => {
      socket.on('lookup', () => { marks.dns = Date.now() - started; });
      socket.on('connect', () => { marks.tcp = Date.now() - started; });
      socket.on('secureConnect', () => {
        marks.tls = Date.now() - started;
        finish({});
      });
    });
    req.on('timeout', () => finish({ code: 'ETIMEDOUT' }));
    req.on('error', (error) => finish({ code: causeCode(error) || 'HANDSHAKE_FAILED' }));
    req.end();
  });
}

// 中转站（one-api / new-api 这一支）路径写错时，会把答案直接写进错误体：
//   {"error":{"message":"Invalid URL (GET /v2/models), you may need [GET /v1/models, GET /v1beta/models]"}}
// 读得出这句，就能把「这台服务器没有列模型的接口」和「地址路径填错了」分开。
// 两者都是 404，但后果完全不同：后者生成时也会 404，不能说成「能连上」。
function suggestedModelPath(text, askedPath) {
  if (!text) return '';
  const scope = /you may need\s*\[([^\]]+)\]/i.exec(text);
  // 只在括号里那串建议路径中找，避免把自己请求的路径当成答案。
  const m = /(\/[A-Za-z0-9._~\/-]*\/models)\b/i.exec(scope ? scope[1] : text);
  if (!m) return '';
  const found = m[1];
  // 正文里可能只重复了我们刚发的那条路径（说明渠道没给建议），那不是答案。
  // 宁可退回「核不了模型名」，也不要指一条和用户填的一模一样的路——那等于没说。
  return found === askedPath ? '' : found;
}

async function readText(response) {
  // 桩对象和已被消费过的响应不一定有 text()，读不到就当对面没说。
  if (!response || typeof response.text !== 'function') return '';
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function bareId(id) {
  // 少数渠道按 Gemini 原生格式返回 models/gemini-3.1-flash-image，比对时统一去掉前缀。
  return String(id || '').trim().replace(/^models\//i, '');
}

// Vertex AI Express Mode 的连通测试走另一条路：不打 /models，发一条最小探针。
//
// 为什么不能用 /models：AQ. 开头的 Express Mode Key 权限只覆盖推理与生成接口，
// GET /models 会固定返回「API keys are not supported by this API」（401），
// 也就是说这条路对有效 Key 也必然失败——测出来的是假的「Key 不对」。
//
// 探针取 gemini-3.5-flash-lite + maxOutputTokens=1：请求体最小、花费可忽略，
// 200 就同时证明了「地址对、Key 有效、这个模型可用」。模型名对不对不在此列——
// Express Mode 根本不给列表，模型清单只能内置，面板会把这层说清楚。
async function probeVertex(draft, { fetchImpl, timeoutMs }) {
  const started = Date.now();
  let url;
  try {
    url = vertexGenerateUrl(draft.baseUrl, VERTEX_PROBE_MODEL);
  } catch (error) {
    throw problem('CHANNEL_TEST_FAILED', error.message || '接口地址无效。');
  }

  let response;
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref();
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      // 原生 :generateContent 只认 x-goog-api-key；带 Bearer 会被判 401 UNAUTHENTICATED。
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': draft.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    // 代理握手被掐和「等模型回话」在 undici 里长得一样，靠 timedOut 区分；
    // 归因错了，用户就会去改 Key，而真正的问题是线路。
    const { kind, code } = classifyNetError(error, timedOut);
    if (kind === 'wait-timeout') {
      throw problem('CHANNEL_TEST_FAILED', `测试超时：${Math.round(timeoutMs / 1000)} 秒内没有响应。到 Google 的线路可能不通，或者需要挂代理。`);
    }
    throw problem('CHANNEL_TEST_FAILED', `连不上 aiplatform.googleapis.com${code ? '（' + code + '）' : ''}：${connectHint(code)}`);
  }
  const latencyMs = Date.now() - started;

  if (response.status === 401 || response.status === 403) {
    throw problem('CHANNEL_TEST_FAILED', `Key 被拒绝（HTTP ${response.status}）：Express Mode 的 AQ. Key 只能用 x-goog-api-key 传；确认没把别家的 Key 填进来，也没把它当成 OAuth 令牌用。`);
  }
  if (response.status === 404) {
    throw problem('CHANNEL_TEST_FAILED', `地址路径不对（HTTP 404）：Vertex 上没有 ${VERTEX_PROBE_MODEL}。服务地址应该填 https://aiplatform.googleapis.com/v1（带 /projects/…/locations/… 的写法也可以）。`);
  }
  if (response.status === 429) {
    throw problem('CHANNEL_TEST_FAILED', 'HTTP 429：地址和 Key 是通的，但配额/频率被限了。稍等一会儿再测。');
  }
  if (!response.ok) {
    throw problem('CHANNEL_TEST_FAILED', `渠道返回 HTTP ${response.status}：地址是通的，但这个请求被拒了。`);
  }

  return {
    ok: true,
    status: response.status,
    model: draft.model || '',
    // Express Mode 没有模型列表，这里只能如实说「核不了」，不能假装命中。
    modelFound: null,
    modelCount: 0,
    similar: [],
    latencyMs,
    // 面板靠这个字段决定文案：这次是探针验证，不是列表命中。
    probe: 'vertex-generate-content',
    probeModel: VERTEX_PROBE_MODEL
  };
}

// BFL 的连通测试打 GET /v1/credits。这是实测算出来的路，四个候选里只有它对：
//
//   GET /v1/credits   → 200 {"credits":1000} / 403 Not authenticated / 422 Invalid API key format
//   GET /v1/models    → 404（BFL 根本没有列模型的接口）
//   GET /v1/get_result?id=<假 id> → 一律 404 Task not found，**而且完全不校验 Key**：
//                                    拿错 Key、不填 Key 都是同一个 404。用它做探针，
//                                    等于给任何一把乱填的 Key 发通行证。
//
// 顺带白捡一个余额：BFL 用 402 表示余额不足，提前看到 credits 就能在生成前
// 把「余额干了」和「Key 不对」分开，而不是等任务失败再去猜。
async function probeBfl(draft, { fetchImpl, timeoutMs }) {
  const started = Date.now();
  let url;
  try {
    url = bflRoot(draft.baseUrl) + '/credits';
  } catch (error) {
    throw problem('CHANNEL_TEST_FAILED', error.message || '接口地址无效。');
  }

  let response;
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref();
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      // 只有 x-key 一种鉴权。带 Bearer 会被 403 Not authenticated。
      headers: { accept: 'application/json', 'x-key': draft.apiKey },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    const { kind, code } = classifyNetError(error, timedOut);
    if (kind === 'wait-timeout') {
      throw problem('CHANNEL_TEST_FAILED', `测试超时：${Math.round(timeoutMs / 1000)} 秒内没有响应。到 api.bfl.ai 的线路可能不通，或者需要挂代理。`);
    }
    throw problem('CHANNEL_TEST_FAILED', `连不上 api.bfl.ai${code ? '（' + code + '）' : ''}：${connectHint(code)}`);
  }
  const latencyMs = Date.now() - started;

  // 超时保护必须覆盖到**读完响应体**，而且要显式赛一道：abort 能不能中断
  // body 读取，取决于底层实现和代理是否配合，实测走 HTTPS_PROXY 时头 200 到了、
  // body 永远不来。只靠 clearTimeout 时机的写法会让请求无限挂着，
  // 面板上表现为「测试中…」永不结束。
  let text = '';
  let bodyTimedOut = false;
  let bodyTimerId = null;
  const bodyGuard = new Promise((_, reject) => {
    bodyTimerId = setTimeout(() => { bodyTimedOut = true; reject(new Error('BODY_TIMEOUT')); }, timeoutMs);
  });
  try {
    text = typeof response.text === 'function' ? await Promise.race([response.text(), bodyGuard]) : '';
    clearTimeout(bodyTimerId);
  } catch (error) {
    clearTimeout(bodyTimerId);
    if (bodyTimedOut || timedOut) {
      throw problem('CHANNEL_TEST_FAILED', `已经连上 api.bfl.ai 并拿到响应头（HTTP ${response.status}），但 ${Math.round(timeoutMs / 1000)} 秒内读不到内容。这通常是代理在转发响应体时卡住：把代理换成 TUN / 系统代理模式（让 Node 直连也能走代理）再测一次。`);
    }
    throw problem('CHANNEL_TEST_FAILED', `读取 BFL 的响应时连接中断（HTTP ${response.status}）。`);
  }
  clearTimeout(timer);

  let payload = null;
  let detail = '';
  try {
    payload = text ? JSON.parse(text) : null;
    detail = payload && payload.detail ? String(payload.detail) : '';
  } catch {
    payload = null;
    detail = '';
  }

  // 403 而不是 401：BFL 对「没带 / 带错鉴权头」统一回 403 Not authenticated。
  if (response.status === 401 || response.status === 403) {
    throw problem('CHANNEL_TEST_FAILED', `Key 被拒绝（HTTP ${response.status}${detail ? '：' + detail : ''}）。BFL 只认 x-key 这个头，Bearer 一律不认；确认没把别家的 Key 填进来。`);
  }
  // 422 是格式检查没过，比 403 更具体：Key 形态就不对（比如少了 bfl_ 前缀、复制时截断了）。
  if (response.status === 422) {
    throw problem('CHANNEL_TEST_FAILED', `Key 格式不对（HTTP 422${detail ? '：' + detail : ''}）。BFL 的 Key 形如 bfl_ 加 32 位字符，检查是否复制完整。`);
  }
  if (response.status === 404) {
    throw problem('CHANNEL_TEST_FAILED', `地址路径不对（HTTP 404）：${url} 不存在。服务地址填 https://api.bfl.ai 就行，不要带 /v1。`);
  }
  if (!response.ok) {
    throw problem('CHANNEL_TEST_FAILED', `渠道返回 HTTP ${response.status}${detail ? '：' + detail : ''}：地址是通的，但这个请求被拒了。`);
  }

  const credits = payload && Number.isFinite(Number(payload.credits)) ? Number(payload.credits) : null;
  return {
    ok: true,
    status: response.status,
    model: draft.model || BFL_DEFAULT_MODEL,
    // BFL 也不给模型列表，和 Vertex 一样只能如实说「核不了」。
    modelFound: null,
    modelCount: 0,
    similar: [],
    latencyMs,
    probe: 'bfl-credits',
    credits
  };
}

function createChannelProbe({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // BFL 分支不用全局 fetch（undici 的实验性代理 agent 读不到 body，详见 node-fetch.js）。
  // 测试注入的 fetchImpl 仍然优先，形状不变。
  const nativeFetch = createNodeFetch();
  // draft 由 channel-store.resolveDraft() 产出：{ baseUrl, model, apiKey, sizeMode }
  //
  // 探针本身报的是「这一次请求花了多久」，里面混着 DNS、TCP、TLS 和服务端处理。
  // 慢的时候必须能拆开，否则用户只会看到「测试通过但很慢」，不知道该换节点还是换渠道。
  return async function probe(draft) {
    const result = await runProbe(draft);
    // 只在探针明显慢（≥800ms）时才补测握手：快线多测一次纯属白花时间，
    // 慢线才需要知道卡在 DNS 还是 TLS。顺序执行——两条连接同时握会让彼此都变慢，
    // 测出来的数字反而是假的（实测并发时整次测试从 3.3s 涨到 5s）。
    const slow = result && result.ok === true && Number(result.latencyMs) >= 800;
    // BFL 一律不测握手：它必须走代理，而这里的握手是**直连**测的——
    // 测出来的 DNS/TCP/TLS 跟用户实际走的路径无关，只会误导；
    // 更要紧的是国内直连查 api.bfl.ai 的 DNS 会挂住（https 的 timeout 管不到解析阶段），
    // 一测就把整次连通测试拖死。
    if (!slow || fetchImpl !== fetch || isBflChannel(draft)) return result;
    const handshake = await handshakeTimings(draft && draft.baseUrl, 2500);
    return handshake ? Object.assign({}, result, { handshake }) : result;
  };

  async function runProbe(draft) {
    // Vertex 渠道不能去敲 /models（AQ. Key 必然 401），先分流。
    if (isVertexChannel(draft)) return probeVertex(draft, { fetchImpl, timeoutMs });
    // BFL 同理：没有 /models，且 x-key 之外的鉴权头一律不认。
    if (isBflChannel(draft)) return probeBfl(draft, { fetchImpl: fetchImpl === fetch ? nativeFetch : fetchImpl, timeoutMs });
    const root = normalizeBaseUrl(draft.baseUrl);
    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(root + '/models', {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${draft.apiKey}` }
      });
    } catch (error) {
      const code = causeCode(error);
      if (isTimeout(error)) {
        throw problem('CHANNEL_TEST_FAILED', `测试超时：${Math.round(timeoutMs / 1000)} 秒内没有响应。地址可能不对，或者渠道此刻很慢。`);
      }
      throw problem('CHANNEL_TEST_FAILED', `连不上这个地址${code ? '（' + code + '）' : ''}：域名解析或端口没通。检查服务地址有没有写错、需不需要挂代理。`);
    }
    const latencyMs = Date.now() - started;

    if (response.status === 401 || response.status === 403) {
      throw problem('CHANNEL_TEST_FAILED', `Key 被拒绝（HTTP ${response.status}）：这个 Key 不对、已过期，或者不属于这个渠道。注意别把别家的 Key 填进来。`);
    }
    // 404 有两种可能：渠道干脆没有 /models 接口，或者地址指到了不存在的路径。
    // 大多数中转会在正文里说明该用哪个路径，读到就把「地址写错」判成失败——
    // 那种情况下生成也必然失败，让它显示成「能连上」是最坏的误导。
    if (response.status === 404) {
      const asked = new URL(root).pathname + '/models';
      const suggested = suggestedModelPath(await readText(response), asked);
      if (suggested) {
        const origin = new URL(root).origin;
        const base = suggested.replace(/\/models$/i, '');
        throw problem('CHANNEL_TEST_FAILED', `地址路径不对（HTTP 404）：${asked} 这个路径不存在，渠道认的是 ${suggested}。把服务地址改成 ${origin}${base}。`);
      }
      return { ok: true, status: 404, model: draft.model, modelFound: null, modelCount: 0, similar: [], latencyMs };
    }
    if (!response.ok) {
      const hint = response.status === 429 ? '（请求太频繁，稍等一会儿再测）' : '';
      throw problem('CHANNEL_TEST_FAILED', `渠道返回 HTTP ${response.status}${hint}：地址是通的，但这个请求被拒了。`);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const list = Array.isArray(payload && payload.data) ? payload.data
      : Array.isArray(payload) ? payload : null;
    if (!list) {
      return { ok: true, status: response.status, model: draft.model, modelFound: null, modelCount: 0, similar: [], latencyMs };
    }
    const ids = list
      .map((item) => (typeof item === 'string' ? item : item && (item.id || item.name)))
      .filter(Boolean)
      .map(bareId);
    const wanted = bareId(draft.model).toLowerCase();
    const modelFound = ids.some((id) => id.toLowerCase() === wanted);
    return {
      ok: true,
      status: response.status,
      model: draft.model,
      modelFound,
      modelCount: ids.length,
      similar: modelFound ? [] : ids.filter((id) => IMAGE_HINT.test(id)).slice(0, 6),
      latencyMs
    };
  }
}

module.exports = { createChannelProbe, DEFAULT_TIMEOUT_MS, handshakeTimings };
