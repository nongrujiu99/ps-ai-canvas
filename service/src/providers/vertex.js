'use strict';

// Google Vertex AI 供应商（Express Mode / API Key）。
//
// 这不是「OpenAI 兼容接口换个域名」，而是另一套协议，四个地方全都不一样：
//
//   1. 路径是 POST /publishers/google/models/{model}:generateContent，
//      没有 multipart、没有 /images/edits、**没有 mask**；
//   2. 鉴权只认 x-goog-api-key。用 Authorization: Bearer 打原生接口会直接
//      401 UNAUTHENTICATED（Bearer 只对 OAuth2 令牌和 /openai/ 兼容端点有效）；
//   3. Express Mode 的 AQ. Key 不能调 GET /models（固定 401），所以模型清单
//      只能内置，连通性也只能靠一条 maxOutputTokens=1 的探针来验；
//   4. 返回体是 candidates[0].content.parts[].inlineData.data（base64），
//      不是 data[].b64_json。
//
// 几何仍然由我们自己兜底：generateContent 没有 mask，模型会「重新画一遍」，
// 所以扩图不能指望它只画新增区。做法是——先把画布补到最接近的标准比例
// （只补不裁，补出来的地方按照片边缘外推填充，模型看到的是连续画面），
// 模型回图后重采样回输入尺寸、裁回画布，再由 composeExpand 只取新增条带。
// 模型画成什么样都不会改到原照片，这是 CEP applyExpand 依赖的契约。

const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { problem } = require('../contract');
const { createTtlMap } = require('../ttl-map');
const { decodeCapture, inspectImage, buildExpandInput } = require('../image-inspection');
const { composeExpand, expandStrips, saneBounds } = require('../expand-compose');
const { buildExpandPrompt } = require('../expand-prompt');
const { aspectForCanvas, ratioValue } = require('./openai-compat');

// 连通性探针专用模型。Express Mode 不给列模型，只能拿一个确定存在的小模型试。
// 这条请求 maxOutputTokens=1，花费可以忽略；返回 200 就证明地址和 Key 都对。
const PROBE_MODEL = 'gemini-3.5-flash-lite';

// 内置生图模型清单。Express Mode 拿不到 /models，所以这份清单就是「可选模型」的唯一来源，
// 面板也照它渲染下拉。用户填了清单外的名字时仍然原样发出去——渠道上新模型不需要等我们发版。
//
// 只收实测存在过的 ID。Nano Banana 是产品昵称不是模型 ID：nano banana =
// gemini-2.5-flash-image、nano banana pro = gemini-3-pro-image、新一代 =
// gemini-3.1-flash-image；而 gemini-nano-banana-2.1 这类写法一律 404 NOT_FOUND。
const IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-3-pro-image'];

// 重新生成一张图可能比「改一处」慢得多，4K 档尤其。默认给到 3 分钟，
// 比 openai-compat 宽松，避免大画布在正常耗时内被判超时。
const DEFAULT_REQUEST_TIMEOUT_MS = 180000;

const DEFAULT_EDIT_PROMPT = '按提示词修改这张图，未提到的部分尽量保持原样。';

// 只认 Vertex 的域名。这条判断存在的意义是防止把普通中转站误判成 Vertex：
// 「地址里没有 /projects/」单独看太宽，几乎每家 /v1 都满足。
const VERTEX_HOST = /(^|\.)aiplatform\.googleapis\.com$/i;
const GENERATELANGUAGE_HOST = /(^|\.)generativelanguage\.googleapis\.com$/i;

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function parseUrl(value) {
  try {
    return new URL(trimTrailingSlash(value));
  } catch {
    return null;
  }
}

// 是不是 Vertex 的地址。除了官方域名，也接受把 Vertex 路径反代到自有域名的写法：
// 只要路径里出现 /publishers/google/models，或直接是 generativelanguage，
// 都按同一套协议处理。
function isVertexBaseUrl(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url) return false;
  if (VERTEX_HOST.test(url.hostname) || GENERATELANGUAGE_HOST.test(url.hostname)) return true;
  if (/\/publishers\/google\/models(\/|$)/i.test(url.pathname)) return true;
  return false;
}

// Express Mode 的 Key 前缀固定是 AQ.。这个判断还可以用于「提示用户别把
// 普通 API Key 填进来」——两种 Key 的权限边界完全不同。
function isVertexApiKey(apiKey) {
  return /^AQ\./i.test(String(apiKey || '').trim());
}

// Vertex 渠道的判定：地址是 Vertex 就算。
//
// 规范里「AQ. 开头 / 地址不含 /projects/」这两个特征是 Express Mode 的标志，
// 用来决定「能不能碰 /models」——而 /models 在这套协议里本来就不是 OpenAI 的
// data[] 格式，带项目与区域的完整路径也只是换了个调用位置，列模型同样不可靠。
// 所以这里统一按「是 Vertex 就不碰 /models」处理，判定条件取地址即可。
function isVertexChannel(channel) {
  return Boolean(channel) && isVertexBaseUrl(channel.baseUrl);
}

// Express Mode 的判定单独留一个：面板文案、以及以后要区分「有没有项目路径」
// 的时候用得上，不该和「是不是 Vertex」混成一个布尔。
function isVertexExpress(channel) {
  if (!isVertexChannel(channel)) return false;
  const baseUrl = String(channel.baseUrl || '');
  return isVertexApiKey(channel.apiKey) || !/\/projects\/[^/]+\/locations\/[^/]+/i.test(baseUrl);
}

// 把用户填的种种写法收敛成一个「基址」：
//   https://aiplatform.googleapis.com/v1
//   https://aiplatform.googleapis.com
//   https://aiplatform.googleapis.com/v1/projects/p/locations/l
//   https://aiplatform.googleapis.com/v1/publishers/google/models/x:generateContent  ← 整条粘进来
// 前两种补 /v1，第三种原样保留（它自己已经带版本与范围），第四种先把模型段剥掉。
function vertexRoot(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url) throw problem('INVALID_ENDPOINT', '接口地址无效，需要形如 https://aiplatform.googleapis.com/v1 的地址。');
  if (!/^https?:$/.test(url.protocol)) throw problem('INVALID_ENDPOINT', '接口地址必须是 http 或 https。');
  let path = url.pathname.replace(/\/+$/, '');
  // 用户如果把完整 endpoint 粘进来，剥掉 /publishers/google/models/{model}:xxx 这一截。
  path = path.replace(/\/publishers\/google\/models\/[^/]+(?::[A-Za-z]+)?$/i, '');
  if (!/\/projects\/[^/]+\/locations\/[^/]+/i.test(path) && !/\/v\d+[a-z0-9]*$/i.test(path)) {
    path += '/v1';
  }
  return url.origin + path;
}

// 完整调用地址。stream=true 时给 SSE 版本，面板现在不用，但留着免得以后又拼一遍。
function vertexGenerateUrl(baseUrl, model, { stream = false } = {}) {
  const id = String(model || '').trim();
  if (!id) throw problem('INVALID_CHANNEL', '请先选择模型。');
  const root = vertexRoot(baseUrl);
  const suffix = stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
  return root + '/publishers/google/models/' + encodeURIComponent(id) + suffix;
}

function stripDataUrl(value) {
  const text = String(value || '');
  const comma = text.indexOf(',');
  return text.startsWith('data:') && comma > 0 ? text.slice(comma + 1) : text;
}

function causeCode(error) {
  let node = error;
  for (let depth = 0; node && depth < 4; depth++) {
    if (node.code) return String(node.code);
    node = node.cause;
  }
  return '';
}

// 失败必须分三类，因为用户该做的事完全不同：
//   wait-timeout  请求发出去了、对面一直不回 → 图太大/模型慢，可以再等或降档
//   connect       根本没连上（DNS 解析不了、代理 CONNECT 失败）→ 是线路/代理的问题
//   reset         连上又被掐断 → 出口抖动，重试通常就好
// 以前把 connect 也算成 timeout，于是 14 秒就挂的请求被报成「180 秒内没有返回，
// 4K 出图本来就慢」，用户只会去重试 4K，越试越亏时间。
//
// 注意：不能靠 error.name 区分「我们自己 abort 的超时」和「代理握手被 abort」——
// 两者在 undici 里都是 AbortError/UND_ERR_ABORTED。所以超时由调用方传入 timedOut 标记。
const CONNECT_CODES = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_ABORTED|ETIMEDOUT)$/;
const RESET_CODES = /^(ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CLOSED)$/;
// 明确「换一次也不会变」的：域名解析不了、端口被拒。重试只是把同样的失败再等一遍。
const DETERMINISTIC_CONNECT = /^(ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)$/;

function classifyNetError(error, timedOut) {
  const code = causeCode(error);
  if (timedOut) return { kind: 'wait-timeout', code };
  if (RESET_CODES.test(code)) return { kind: 'reset', code };
  if (CONNECT_CODES.test(code)) return { kind: 'connect', code };
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'wait-timeout', code };
  return { kind: 'other', code };
}

function connectHint(code) {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return '本机 DNS 解析不了 aiplatform.googleapis.com。这个服务不会自动走系统代理：开 TUN/全局模式，或用 --use-env-proxy 启动。';
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_ABORTED') {
    return '连 Google 超过 10 秒没握上手。代理端口通了但出口不通是最常见的原因——换节点，或开 TUN/全局模式。';
  }
  if (code === 'ECONNREFUSED') return '连接被本机拒绝，代理端口没在监听。';
  return '本机到 Google 的线路不通，先确认代理能用。';
}

// 出口线路抖动是真实存在的：同一条通道、同一份配置，探针 200，紧接着出图 ECONNRESET，
// 手动再点一次又 200。这类失败与请求内容无关（Key、地址、模型名都没错），重试就能过。
// 判据在 classifyNetError 里，这里只放延迟。
const NET_RETRY_DELAYS = [700, 1800];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimDetail(text, limit = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

// 上游错误体里通常带 { error: { code, message, status } }。把 message 捞出来接在
// 我们自己那句人话后面，用户和我们都还能看出真正原因（比如模型名拼错、区域不支持）。
function upstreamDetail(payload) {
  if (!payload) return '';
  const error = payload.error || payload;
  const message = typeof error.message === 'string' ? error.message : '';
  return trimDetail(message);
}

// 比例 → 档位。Vertex 只认 1K/2K/4K，按长边走：小图不必付 4K 的钱，
// 大图给低了会糊。
function sizeTierFor(width, height) {
  const side = Math.max(Number(width) || 0, Number(height) || 0);
  if (side <= 1024) return '1K';
  if (side <= 2048) return '2K';
  return '4K';
}

// 把画布补到最接近的标准比例（只补不裁）。
// 为什么必须补：generateContent 只能按固定比例出图，画布比例怪的时候模型会把画面
// 拉伸/裁切，回来再缩放就是二次变形。补到标准比例后，「出图比例 = 输入比例」，
// 重采样只做等比缩放，几何不变。补出来的边缘用照片像素外推填充（buildExpandInput），
// 模型看到的是连续画面，不是黑边。
function planPaddedCanvas(canvas) {
  const picked = aspectForCanvas(canvas);
  const target = ratioValue(picked.ratio) || 1;
  const aspect = canvas.width / canvas.height;
  let width = canvas.width;
  let height = canvas.height;
  if (aspect < target) width = Math.ceil(canvas.height * target);
  else if (aspect > target) height = Math.ceil(canvas.width / target);
  // 均分到两侧，原图仍在正中；奇数差多出来的 1px 放右边/下边，反正会被裁回去。
  return {
    width,
    height,
    left: Math.floor((width - canvas.width) / 2),
    top: Math.floor((height - canvas.height) / 2),
    ratio: picked.ratio
  };
}

function parseRequestedSize(size) {
  const match = /^(\d+)\s*[*x×]\s*(\d+)$/i.exec(String(size || '').trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function createVertexProvider({
  fetchImpl = fetch,
  baseUrl,
  apiKey,
  model = IMAGE_MODELS[0],
  imageSize,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
} = {}) {
  if (!isVertexBaseUrl(baseUrl)) {
    throw problem('INVALID_ENDPOINT', '这个地址不是 Vertex AI 的接口：需要 https://aiplatform.googleapis.com/v1。');
  }
  if (!apiKey) throw problem('CHANNEL_NOT_CONFIGURED', '还没填 Vertex 的 API Key。');

  const root = vertexRoot(baseUrl);
  // 结果按 taskId 暂存：generateContent 是同步接口，提交那一刻图就已经回来了，
  // 没必要为了「提交—轮询—下载」的老流程再等一轮。
  const pending = createTtlMap();

  async function call(modelId, body, timeoutMs = requestTimeoutMs) {
    const url = vertexGenerateUrl(root, modelId);
    let response;
    // 定时器要在循环外持有：它必须活到**响应体读完**。
    // 拿到响应头就 clearTimeout 的写法，在代理转发 body 卡住时会无限挂起
    // （实测 HTTPS_PROXY 下：头 200 到了，body 永远不来）。
    let timer = null;
    let timedOut = false;
    for (let attempt = 0; ; attempt++) {
      // 自己控制 abort：只有我们能确定「是这个定时器掐的」才算等待超时，
      // 代理握手被掐（同样是 AbortError）要归到 connect，不能混为一谈。
      const controller = new AbortController();
      timedOut = false;
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          // 只用 x-goog-api-key：原生 :generateContent 收到 Bearer 会直接 401。
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        break;
      } catch (error) {
        clearTimeout(timer);
        const { kind, code } = classifyNetError(error, timedOut);
        process.stderr.write('[vertex] 请求失败 kind=' + kind + (code ? ' code=' + code : '') + '\n');

        if (kind === 'wait-timeout') {
          throw problem('VERTEX_TIMEOUT', `请求已发出，${Math.round(timeoutMs / 1000)} 秒内没有回话。画布越大越慢，4K 档偶尔要一两分钟；如果每次都在同一秒数卡死，那就是出口线路的问题，不是模型慢。`);
        }
        // 连不上时重试要克制：ENOTFOUND / ECONNREFUSED 是确定的，再等一遍只是白白多等十几秒。
        const retryable = kind === 'reset'
          || (kind === 'connect' && !DETERMINISTIC_CONNECT.test(code));
        if (retryable && attempt < NET_RETRY_DELAYS.length) {
          process.stderr.write('[vertex] ' + (code || kind) + '，第 ' + (attempt + 1) + ' 次重试\n');
          await delay(NET_RETRY_DELAYS[attempt]);
          continue;
        }
        if (kind === 'connect') {
          throw problem('VERTEX_UNREACHABLE', `连不上 aiplatform.googleapis.com${code ? '（' + code + '）' : ''}：${connectHint(code)}`);
        }
        throw problem('VERTEX_UNREACHABLE', `连接被中断${code ? '（' + code + '）' : ''}：出口线路抖了一下，已经自动重试 ${attempt} 次仍没成功，过一会儿再点一次通常就好。`);
      }
    }

    // body 读取不能只靠 abort：代理卡住时 abort 未必能传到 body 流。
    // 这里显式赛一道，保证「无论如何都会退出」，不会让面板停在「生成中」。
    let text = '';
    let bodyTimedOut = false;
    let bodyTimerId = null;
    const bodyGuard = new Promise((_, reject) => {
      bodyTimerId = setTimeout(() => { bodyTimedOut = true; reject(new Error('BODY_TIMEOUT')); }, timeoutMs);
    });
    try {
      text = await Promise.race([response.text(), bodyGuard]);
      clearTimeout(bodyTimerId);
    } catch (error) {
      clearTimeout(bodyTimerId);
      if (bodyTimedOut || timedOut) {
        throw problem('VERTEX_TIMEOUT', `已经连上 aiplatform.googleapis.com 并拿到响应头（HTTP ${response.status}），但 ${Math.round(timeoutMs / 1000)} 秒内读不到结果。通常是代理转发响应体卡住：把代理换成 TUN / 系统代理模式再试。`);
      }
      throw problem('VERTEX_UNREACHABLE', `读取 Vertex 的响应时中断（HTTP ${response.status}）。`);
    }
    clearTimeout(timer);
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    const detail = upstreamDetail(payload);

    if (response.status === 401 || response.status === 403) {
      throw problem('VERTEX_AUTH_FAILED', `Vertex 拒绝了这把 Key（HTTP ${response.status}）${detail ? '：' + detail : '。'}Express Mode 的 AQ. Key 只能通过 x-goog-api-key 传，确认没填成别家的 Key。`);
    }
    if (response.status === 404) {
      throw problem('VERTEX_MODEL_MISSING', `Vertex 上找不到模型「${modelId}」（HTTP 404）${detail ? '：' + detail : '。'}检查模型名，或地址是否少了 /v1。`);
    }
    if (response.status === 429) {
      throw problem('VERTEX_RATE_LIMITED', `Vertex 限流或配额用尽（HTTP 429）${detail ? '：' + detail : '。'}稍等一会儿再试，或换一个模型。`);
    }
    if (!response.ok || (payload && payload.error)) {
      throw problem('VERTEX_REQUEST_FAILED', `Vertex 返回 HTTP ${response.status}${detail ? '：' + detail : '。'}`);
    }
    if (!payload) throw problem('VERTEX_RESPONSE', 'Vertex 返回了无法识别的响应。');

    // 请求的模型名和响应里报的版本不一致，是「被顶替」的唯一可见线索。
    // 官方 Vertex 一般不会发生，但反代/中转会，留一行日志比事后猜便宜。
    const returned = String(payload.modelVersion || '');
    if (returned && returned !== modelId) {
      process.stderr.write('[vertex] 请求 model=' + modelId + ' 响应 modelVersion=' + returned + '\n');
    }
    return payload;
  }

  // 从 candidates[0].content.parts[] 里找 inlineData。找不到图就把模型说的话带出来，
  // 否则用户只看到「未返回图像」，完全不知道是安全策略还是模型名错了。
  function extractImage(payload) {
    const candidate = Array.isArray(payload && payload.candidates) ? payload.candidates[0] : null;
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    for (const part of parts) {
      const inline = part && (part.inlineData || part.inline_data);
      if (inline && typeof inline.data === 'string' && inline.data) {
        return Buffer.from(stripDataUrl(inline.data), 'base64');
      }
    }
    const said = parts.filter((part) => part && typeof part.text === 'string')
      .map((part) => part.text).join(' ').trim();
    const finish = candidate && candidate.finishReason ? `（finishReason=${candidate.finishReason}）` : '';
    const blocked = payload && payload.promptFeedback && payload.promptFeedback.blockReason
      ? `（提示词被拦截：${payload.promptFeedback.blockReason}）` : '';
    throw problem('VERTEX_NO_IMAGE', '模型没有返回图像' + finish + blocked
      + (said ? '：' + trimDetail(said) : '。') + '');
  }

  async function submitGenerate(job) {
    const requested = parseRequestedSize(job.size) || { width: 1024, height: 1024 };
    const picked = aspectForCanvas(requested);
    // 种子在这张模型上是真生效的（实测：同种子两次出图逐像素完全相同，差 0.00；
    // 换种子差 28.9）。所以「留空」不能真的不传——那叫「这次用了什么种子没人知道」，
    // 出了满意的一张也没法复现。留空时这里自己摇一个，随结果一起回面板。
    const seed = Number.isInteger(job.seed) ? job.seed : Math.floor(Math.random() * 2147483647);
    const body = {
      contents: [{ role: 'user', parts: [{ text: String(job.prompt || '').trim() || '生成一张图片。' }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: picked.ratio,
          imageSize: imageSize || sizeTierFor(requested.width, requested.height)
        },
        seed
      }
    };
    const payload = await call(model, body);
    const taskId = 'vertex-' + randomUUID();
    // 记住请求尺寸：imageConfig.imageSize 只是个档位（1K/2K/4K），模型按档位给图，
    // 2K 的 16:9 实测回来是 2752×1536，而不是请求的 2048×1152。下载时统一缩到
    // 面板上写的那个尺寸，「选什么得什么」——否则面板的「输出尺寸」就是一句谎话，
    // 用户拿到的图比选项大一倍，贴进画布还得自己缩。
    pending.set(taskId, { source: extractImage(payload), composite: null, target: requested });
    // generateContent 一次只回一个候选（传 candidateCount 直接 400）。面板的 2~4 张
    // 在这里没法兑现，就明说一句，别让人以为多花了钱、只是没显示出来。
    const notice = Number(job.n) > 1
      ? '这个通道一次只出一张，已按 1 张生成（候选数量 2~4 只有百炼/中转站支持）。'
      : '';
    return { taskId, size: `${requested.width}*${requested.height}`, notice, seed,
      cost: { channel: 'openai', label: 'gemini', model, imageCount: 1 } };
  }

  function buildBody(inputBytes, prompt, padded) {
    return {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: inputBytes.toString('base64') } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: padded.ratio,
          imageSize: imageSize || sizeTierFor(padded.width, padded.height)
        }
      }
    };
  }

  // 送一块「取景」进去，拿回来同尺寸的一块。
  //
  // region 是画布坐标下要改的那块；photo 是原照片在 region 里的位置（扩图时照片只占
  // region 的一部分，剩下的就是新增区）。整个 region 会先补到标准比例再送模型，
  // 回来重采样 + 裁边，得到的就是 region 大小的成品，几何一次都没有被拉伸。
  async function renderRegion(pngBytes, region, photo, prompt) {
    const regionW = region.right - region.left;
    const regionH = region.bottom - region.top;
    const padded = planPaddedCanvas({ width: regionW, height: regionH });
    const inner = {
      left: photo.left - region.left + padded.left,
      top: photo.top - region.top + padded.top,
      right: photo.right - region.left + padded.left,
      bottom: photo.bottom - region.top + padded.top
    };
    // 取景图先按画布坐标裁出来，再补到标准比例。
    let crop = regionW === 0 || regionH === 0
      ? pngBytes
      : await sharp(pngBytes).extract({ left: region.left, top: region.top, width: regionW, height: regionH }).png().toBuffer();
    if (padded.width !== regionW || padded.height !== regionH) {
      // 先补成 padded 尺寸，才能让下面 buildExpandInput 的「照片在画布里的位置」
      // 和它要裁的源图对得上：那个函数是按「源图 == 目标画布」写的前提。
      // 补出来的底色活不下来——照片以外的地方会被边缘外推整块覆盖。
      crop = await sharp(crop).extend({
        left: padded.left,
        top: padded.top,
        right: padded.width - regionW - padded.left,
        bottom: padded.height - regionH - padded.top
      }).png().toBuffer();
    }
    const inputBytes = await buildExpandInput(crop, { width: padded.width, height: padded.height }, inner);

    const payload = await call(model, buildBody(inputBytes, prompt, padded));
    const raw = extractImage(payload);
    let out = await sharp(raw).resize(padded.width, padded.height, { fit: 'fill' }).png().toBuffer();
    if (padded.width !== regionW || padded.height !== regionH) {
      out = await sharp(out)
        .extract({ left: padded.left, top: padded.top, width: regionW, height: regionH })
        .png().toBuffer();
    }
    return { bytes: out, region, padded };
  }

  async function submitImageTask(job) {
    const { pngBytes, maskBytes } = await decodeCapture(job.image, job.mask);
    const info = await inspectImage(pngBytes, maskBytes);
    const canvas = { width: info.width, height: info.height };
    const isExpand = job.operation === 'expand';

    // ── 扩图：整张画布取景，合成时只取新增条带 ──────────────────────────────
    if (isExpand) {
      // 和另外两个供应商同一条规矩：Photoshop 传来的图层范围是几何真值，
      // alpha 反推只作备胎（照片边缘的半透明描边会让反推偏大）。
      let bounds = saneBounds(job.canvasBounds, canvas);
      if (!bounds) bounds = saneBounds(info.opaqueBounds, canvas);
      if (!bounds) {
        throw problem('NO_EXPAND_AREA', '画布上看不出清晰的「原图 + 透明扩展区」。请先把画布拉大、让原图贴住其中一侧后重试。');
      }
      const prompt = buildExpandPrompt(job.prompt, { bounds, canvas, masked: false });
      const rendered = await renderRegion(pngBytes, { left: 0, top: 0, right: canvas.width, bottom: canvas.height }, bounds, prompt);
      const strips = expandStrips(canvas.width, canvas.height, bounds);
      const composite = {
        window: { left: 0, top: 0, right: canvas.width, bottom: canvas.height },
        strips,
        frame: canvas,
        bounds,
        base: pngBytes
      };
      const taskId = 'vertex-' + randomUUID();
      pending.set(taskId, { source: rendered.bytes, composite });
      process.stderr.write('[vertex] 扩图 画布 ' + canvas.width + 'x' + canvas.height
        + ' 补到 ' + rendered.padded.width + 'x' + rendered.padded.height + '（' + rendered.padded.ratio + '）'
        + ' 档位 ' + (imageSize || sizeTierFor(rendered.padded.width, rendered.padded.height))
        + '，合成只取新增条带 ' + strips.length + ' 条\n');
      return { taskId, size: canvas.width + '*' + canvas.height, notice: '',
        cost: { channel: 'openai', label: 'gemini', model, imageCount: 1 } };
    }

    // ── 选区编辑：只把选区那块（加一圈上下文）送去改，改完贴回原图 ─────────
    // 不能整张送：模型会顺手把整幅重画一遍，选区边缘于是对不上（照片里
    // 「键盘按键变大」就是这么来的）。取景之后模型只在原生尺度上动那一块，
    // 选区外的像素连碰都碰不到。
    const selection = info.selectionKind === 'inside' ? info.selectionBounds : null;
    if (job.operation === 'editMasked' && selection) {
      const marginX = Math.round((selection.right - selection.left) * 0.3);
      const marginY = Math.round((selection.bottom - selection.top) * 0.3);
      const region = {
        left: Math.max(0, selection.left - marginX),
        top: Math.max(0, selection.top - marginY),
        right: Math.min(canvas.width, selection.right + marginX),
        bottom: Math.min(canvas.height, selection.bottom + marginY)
      };
      const prompt = String(job.prompt || '').trim() || DEFAULT_EDIT_PROMPT;
      const rendered = await renderRegion(pngBytes, region, region, prompt);
      const patched = await sharp(pngBytes)
        .composite([{ input: rendered.bytes, left: region.left, top: region.top }])
        .png().toBuffer();
      const taskId = 'vertex-' + randomUUID();
      pending.set(taskId, { source: patched, composite: null });
      process.stderr.write('[vertex] 选区编辑 画布 ' + canvas.width + 'x' + canvas.height
        + ' 只送选区 ' + (region.right - region.left) + 'x' + (region.bottom - region.top)
        + '（含 30% 上下文），选区外原样贴回\n');
      return { taskId, size: canvas.width + '*' + canvas.height, notice: '',
        cost: { channel: 'openai', label: 'gemini', model, imageCount: 1 } };
    }

    // ── 整张重绘（editWhole，或选区识别不出来的兜底）───────────────────────
    const prompt = String(job.prompt || '').trim() || DEFAULT_EDIT_PROMPT;
    const rendered = await renderRegion(pngBytes, { left: 0, top: 0, right: canvas.width, bottom: canvas.height }, { left: 0, top: 0, right: canvas.width, bottom: canvas.height }, prompt);
    const taskId = 'vertex-' + randomUUID();
    pending.set(taskId, { source: rendered.bytes, composite: null });
    process.stderr.write('[vertex] 整图编辑 画布 ' + canvas.width + 'x' + canvas.height
      + ' 补到 ' + rendered.padded.width + 'x' + rendered.padded.height + '\n');
    return { taskId, size: canvas.width + '*' + canvas.height, notice: '',
      cost: { channel: 'openai', label: 'gemini', model, imageCount: 1 } };
  }

  async function submit(job) {
    if (!job || !job.operation) throw problem('INVALID_JOB', '任务缺少操作类型。');
    if (job.operation === 'generate' && !job.image) return submitGenerate(job);
    if (!job.image) throw problem('IMAGE_MISSING', '这个操作需要底图。');
    return submitImageTask(job);
  }

  async function poll(taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(taskId || ''))) throw problem('INVALID_TASK_ID', '任务编号无效。');
    // generateContent 是同步的：提交时就拿到了图，这里只是把结果交出去。
    // 不能在这里删缓存——download 还要按同一个 id 取字节。
    if (!pending.has(taskId)) throw problem('RESULT_UNAVAILABLE', '结果已失效。');
    return { status: 'SUCCEEDED', resultUrls: ['vertex-inline:' + taskId], errorCode: null };
  }

  async function download(url) {
    const text = String(url || '');
    if (!text.startsWith('vertex-inline:')) throw problem('RESULT_URL', '结果地址无效。');
    const key = text.slice('vertex-inline:'.length);
    const item = pending.get(key);
    if (!item) throw problem('RESULT_UNAVAILABLE', '结果已失效。');
    pending.delete(key);
    if (item.composite) {
      try { return await composeExpand(item.source, item.composite); }
      catch { throw problem('RESULT_IMAGE', '结果图像无法读取。'); }
    }
    try {
      // 只有文生图带 target（扩图/编辑走 composite，尺寸由画布决定）。
      if (item.target) {
        return await sharp(item.source).resize(item.target.width, item.target.height, { fit: 'fill' }).png().toBuffer();
      }
      return await sharp(item.source).png().toBuffer();
    }
    catch { throw problem('RESULT_IMAGE', '结果图像无法读取。'); }
  }

  // Express Mode 不支持 GET /models，所以这里直接回内置清单：
  // 谁调用都不会再产生一次注定 401 的请求。
  async function listModels() {
    return IMAGE_MODELS.slice();
  }

  return { submit, poll, download, listModels, model, root };
}

module.exports = {
  createVertexProvider,
  isVertexBaseUrl,
  isVertexApiKey,
  isVertexChannel,
  isVertexExpress,
  vertexRoot,
  vertexGenerateUrl,
  sizeTierFor,
  planPaddedCanvas,
  PROBE_MODEL,
  IMAGE_MODELS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  // 探针复用同一套归因：连不上 ≠ 等太久，两边文案不能各说一套。
  classifyNetError,
  connectHint
};
