'use strict';

// Black Forest Labs（FLUX）供应商。
//
// 这是第三套协议，和前面三家都不一样，有四件事必须记住：
//
//   1. **一个操作一个端点**，不是「一个模型做所有事」：
//        POST /v1/flux-pro-1.0-fill    image + mask          → 只重绘 mask 内
//        POST /v1/flux-pro-1.0-expand  image + 四边像素       → 只补四边
//        POST /v1/{model}              prompt + width/height → 文生图
//      前两个是真正的「定向编辑」，不是靠几何兜底硬裁出来的。
//   2. **鉴权只有 x-key**（x-key: bfl_xxx）。既不是 Bearer，也不是 x-goog-api-key。
//   3. **真异步**：提交回 { id, polling_url }，要一直 GET polling_url 直到
//      status === 'Ready'，图在 result.sample。这和 vertex 的「同步接口假装异步」
//      不是一回事——那边提交时就拿到图了，这边必须真的轮询。
//   4. **result.sample 是 10 分钟有效的签名链接，且 delivery.*.bfl.ai 不开 CORS**。
//      官方明确说不要直接给终端用户，要自己下载再转发。所以这个 URL 绝不能交给
//      面板当 <img src>，必须在 download 里取字节。
//
// 几何为什么用 fill/expand 而不是让模型整张重画：
//   expand 的 top/bottom/left/right 是**整数像素**，和项目 canvasBounds /
//   expandScales 的几何模型是同一套单位，不需要「补到标准比例→出图→缩回→裁边」
//   那套绕法。模型只被允许碰新增的那几条边，原照片区在结构上就不会被重画。
//   fill 的 mask 同理：white=重绘、black=不动，是模型的内建条件，不是靠事后裁切。
//
// 但**契约仍然不变**：返回给面板的图必须是画布尺寸、且只有新增区/选区内有像素变化。
// 所以 expand 依旧过 composeExpand（它现在从「擦屁股」变成「保险」），fill 则按
// mask 复合回原图——比 vertex 的矩形贴回更精确，也保证 mask 外一个像素都不动。

const sharp = require('sharp');
const { problem, DEFAULT_EXPAND_PROMPT } = require('../contract');
const { createTtlMap } = require('../ttl-map');
const { decodeCapture, inspectImage } = require('../image-inspection');
const { composeExpand, expandStrips, saneBounds } = require('../expand-compose');
const { classifyNetError } = require('./vertex');
const { createNodeFetch } = require('./node-fetch');

const DEFAULT_BASE_URL = 'https://api.bfl.ai';
// 路径相对 bflRoot() 的返回值（那已经是 .../v1），所以这里不再带 /v1，
// 否则拼出来是 /v1/v1/... —— 上游会回 404，看起来像模型名写错了。
const FILL_PATH = '/flux-pro-1.0-fill';
const EXPAND_PATH = '/flux-pro-1.0-expand';

// 只列实测跑通过的名字（这个项目的规矩：列出来就等于承诺选它一定行）。
// kontext 系列故意不在这里——它只认 4 档 aspect_ratio，而面板给的是精确宽高，
// 放进来会「不报错、只把画面重排」，这正是最难查的那类问题。
const TEXT_MODELS = ['flux-pro-1.1', 'flux-2-pro-preview'];
const DEFAULT_TEXT_MODEL = 'flux-pro-1.1';

// 提交只是一个入队动作，正常一两秒就回。等太久说明线路有问题，不是模型慢。
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
// 轮询单次请求的超时。轮询自己失败不该让整个任务失败——下一轮继续问。
const POLL_TIMEOUT_MS = 20000;
// 下载签名链接的超时：图几 MB，走代理时 30 秒够。
const DOWNLOAD_TIMEOUT_MS = 60000;

// 模型是英文模型。中文提示词能发出去，但效果通常很差；而扩图/补洞这类任务
// 不写提示词反而更稳（模型按边缘自然延伸）。
const DEFAULT_FILL_PROMPT = 'Fill the masked area naturally, matching the surrounding lighting, texture and style. Keep everything outside the mask unchanged.';

// 安全档位：BFL 的 0~6，0 最严、6 最松，同时作用于**输入和出图**两侧。
// 2026-11-14 排查「无害产品照被判 Content Moderated」时一度以为档位太紧，实测否掉：
// 同一张图档位调到 4 仍然被拦，而真正的触发条件是**送进去的 PNG 里有透明像素**
// （见 tightenToPixels）。所以默认值保持 2 不动，只留一个环境变量做排查用的逃生口。
const DEFAULT_SAFETY_TOLERANCE = 2;

function safetyTolerance() {
  const raw = Number(process.env.STUDIO_BFL_SAFETY_TOLERANCE);
  if (!Number.isFinite(raw)) return DEFAULT_SAFETY_TOLERANCE;
  return Math.min(6, Math.max(0, Math.round(raw)));
}

// BFL 会把「带透明区的底图」判成 Content Moderated（出图审核）。
// 这个结论是排掉尺寸、内容、档位三个变量之后才剩下的：
// 同一张照片、同样输出 1424x1616 —— 送 1024x1216 不透明 → 成功；
// 送 1224x1416（右侧/底部各一条 200px 透明带）→ Content Moderated。
// 于是两条规矩：照片框收到真正有像素的范围（少送一圈透明），
// 残留的透明（照片内部有洞）一律先压到白底。后果都只是「多扩一点」，几何仍对得上。
const MIN_PHOTO_SIDE = 64; // BFL 要求每条边至少 64px，收得比这还小就不动

function tightenToPixels(bounds, opaque) {
  if (!opaque) return bounds;
  const tight = {
    left: Math.max(bounds.left, opaque.left),
    top: Math.max(bounds.top, opaque.top),
    right: Math.min(bounds.right, opaque.right),
    bottom: Math.min(bounds.bottom, opaque.bottom)
  };
  if (tight.right - tight.left < MIN_PHOTO_SIDE || tight.bottom - tight.top < MIN_PHOTO_SIDE) return bounds;
  return tight;
}

function fmtRect(rect) {
  return rect.left + ',' + rect.top + ' ' + (rect.right - rect.left) + 'x' + (rect.bottom - rect.top);
}

// BFL 的 fill 端点有 20MB 硬限（422 "Image file size exceeds 20MB limit"）。这里有两个
// 不同的维度，不能混为一谈：
//   1) 解码后 raw 像素：实测 2048x2560 带 alpha 的 RGBA = 20.00MB 顶线被拒，去掉 alpha
//      变 RGB = 15MB 就过。所以「送出去的图解码后多大」是能否被接受的关键——去 alpha 是
//      真正有效的修复。expand 靠重采样避开，fill 为保 mask 逐像素对齐不能缩尺寸。
//   2) 上传文件字节：转 q95 JPEG 只压这个维度（传输体积），不改变解码后 raw。高噪点大图
//      文件偏大时转一下更安全；但 raw 本身就超限时转 JPEG 救不了，只能如实提示用户。
// 贴回原图用原始 pngBytes/baseBytes，选区外像素零影响。
const BFL_RAW_LIMIT = 20 * 1024 * 1024;   // BFL 按解码后 raw 判定的上限
const FILL_SEND_LIMIT = 12 * 1024 * 1024; // 上传文件字节的安全线，留足 base64 膨胀余量
async function fitFillUpload(pngBytes) {
  const meta = await sharp(pngBytes).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  // 去 alpha 后 BFL 解码得到 RGB，raw = w*h*3。这是判定 20MB 的真实口径。
  const rawRgbBytes = width * height * 3;
  const overRawLimit = rawRgbBytes > BFL_RAW_LIMIT;
  let bytes = pngBytes;
  let steps = [];
  // 无条件去 alpha：全 255 的 alpha 也会让 raw 按 RGBA 算到 20MB。
  if (meta.hasAlpha) {
    bytes = await sharp(bytes).flatten({ background: '#ffffff' }).png().toBuffer();
    steps.push('去alpha通道');
  }
  // 文件字节兜底：压的是传输体积，不改 raw。raw 超限时它救不了，仅减少传输失败概率。
  if (bytes.length > FILL_SEND_LIMIT) {
    bytes = await sharp(bytes).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    steps.push('转JPEG q95');
  }
  return { bytes, steps, formatChanged: steps.length > 0, overRawLimit, rawRgbBytes };
}

const MODERATED = new Set(['Request Moderated', 'Content Moderated']);
const TERMINAL_FAILURES = new Set(['Error', 'Failed', 'Task not found', 'PermanentPending']);

const NET_RETRY_DELAYS = [700, 1800];
const DETERMINISTIC_CONNECT = /^(ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)$/;

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

// 只认 bfl.ai 的域名。这条判断的意义和另外几家一样：防止把普通中转站
// 误判成 BFL。地址对不上就直接拒绝，好过发出去换一个看不懂的 404。
function isBflBaseUrl(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url) return false;
  return /(^|\.)bfl\.ai$/i.test(url.hostname);
}

function isBflChannel(channel) {
  if (!channel) return false;
  if (String(channel.kind || '').toLowerCase() === 'bfl') return true;
  return isBflBaseUrl(channel.baseUrl);
}

// 把用户可能粘贴的几种写法收敛成一个 API 根：
//   https://api.bfl.ai                      → https://api.bfl.ai/v1
//   https://api.bfl.ai/v1                   → 原样
//   https://api.bfl.ai/v1/flux-2-pro-preview → https://api.bfl.ai/v1（模型名另取）
function bflRoot(baseUrl) {
  const url = parseUrl(baseUrl || DEFAULT_BASE_URL);
  if (!url) throw problem('INVALID_ENDPOINT', '接口地址无效，需要形如 https://api.bfl.ai 的地址。');
  if (!/^https?:$/.test(url.protocol)) throw problem('INVALID_ENDPOINT', '接口地址必须是 http 或 https。');
  const path = url.pathname.replace(/\/+$/, '');
  // 先剥掉「整条端点」结尾的模型段，再看是不是已经带 /v1。
  // 不先剥的话 https://api.bfl.ai/v1/flux-2-pro 会被当成「路径不以 /v1 结尾」再加一次。
  const stripped = path.replace(/\/v1\/[A-Za-z0-9._-]+$/i, '').replace(/\/+$/, '');
  return url.origin + (/\/v1$/.test(stripped) ? stripped : stripped + '/v1');
}

// 用户把整条端点粘进「服务地址」很常见（curl 文档里就长那样）。
// 这里把它剥出来当默认模型，省得再让人去找模型名。
function modelFromBaseUrl(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url) return '';
  const match = /\/v1\/([A-Za-z0-9._-]+)$/i.exec(url.pathname.replace(/\/+$/, ''));
  return match ? match[1] : '';
}

function causeCode(error) {
  let node = error;
  for (let depth = 0; node && depth < 4; depth++) {
    if (node.code) return String(node.code);
    node = node.cause;
  }
  return '';
}

function connectHint(code) {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return '本机 DNS 解析不了 api.bfl.ai。这个服务不会自动走系统代理：开 TUN/全局模式，或用 --use-env-proxy 启动。';
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_ABORTED') {
    return '连 BFL 超过 10 秒没握上手。代理端口通了但出口不通是最常见的原因——换节点，或开 TUN/全局模式。';
  }
  if (code === 'ECONNREFUSED') return '连接被本机拒绝，代理端口没在监听。';
  return '本机到 api.bfl.ai 的线路不通，先确认代理能用。';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimDetail(text, limit = 180) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

// BFL 的错误体有两种形状：{ detail: [{ loc, msg, type }] }（422 校验错）
// 和 { detail: "文字" }。两种都要捞出来，否则用户只看到「请求失败」。
function upstreamDetail(payload) {
  if (!payload) return '';
  if (typeof payload.detail === 'string') return trimDetail(payload.detail);
  if (Array.isArray(payload.detail)) {
    return trimDetail(payload.detail.map((item) => item && (item.msg || item.type)).filter(Boolean).join('; '));
  }
  if (typeof payload.message === 'string') return trimDetail(payload.message);
  if (typeof payload.error === 'string') return trimDetail(payload.error);
  return '';
}

// 面板发来的尺寸可能是 "2048*2560"，也可能是旧的档位写法 "1K" / "2K"。
function parseRequestedSize(size) {
  const text = String(size || '').trim();
  const match = /^(\d+)\s*[*x×]\s*(\d+)$/i.exec(text);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (/^1K$/i.test(text)) return { width: 1024, height: 1024 };
  if (/^2K$/i.test(text)) return { width: 2048, height: 2048 };
  return null;
}

// FLUX 不认中文。用户写中文不是错，但得告诉他为什么效果差——
// 否则他会以为是模型不行，而不是语言不对。
function hasChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ''));
}

function createBflProvider({
  // 默认不走全局 fetch：undici 的实验性代理 agent 在这个渠道上会读不到 body（见 node-fetch.js 顶部）。
  // 测试仍然通过注入 fetchImpl 来跑，形状不变。
  fetchImpl = null,
  baseUrl = DEFAULT_BASE_URL,
  apiKey,
  model,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS
} = {}) {
  if (!apiKey) throw problem('CHANNEL_NOT_CONFIGURED', '还没填 Black Forest Labs 的 API Key。');
  const doFetch = fetchImpl || createNodeFetch();
  const root = bflRoot(baseUrl);
  const textModel = String(model || modelFromBaseUrl(baseUrl) || DEFAULT_TEXT_MODEL).trim() || DEFAULT_TEXT_MODEL;

  // taskId → { pollingUrl, target, composite, maskBytes, baseBytes }
  // Ready 之后再把同一份几何说明搬到 sampleUrl 名下。
  // 用 TTL 自动过期、不手动删：这样面板点「重试」时还能只重下、不重生成。
  const pending = createTtlMap();

  // 所有请求共用一套归因和重试。上次 Vertex 就是靠这个把「14 秒连不上」
  // 从「180 秒模型超时」里分出来的，这里没必要另写一套。
  // expect 决定 404 怎么解释。这个区分是实测算出来的，不是猜的：
  // submit 打到 api.bfl.ai 时，404 只可能是「端点/模型名不对」；
  // 但任务其实跑在区域集群上（实测 polling_url 指向 api.us7.bfl.ai），
  // 拿主域名去查会得到 404 Task not found —— 那是查错了地方，不是模型名错。
  // 把它报成「检查模型名」，用户会去改一个本来正确的字段。
  async function request(url, { method = 'GET', body, timeoutMs = requestTimeoutMs, expect = 'submit' } = {}) {
    let response;
    // 超时定时器的宿主放在循环外：它要一直活到**响应体读完**。
    // 实测走 HTTPS_PROXY 时，响应头会正常返回（200），但 body 一直读不到；
    // 如果拿到头就 clearTimeout，整个请求就无限挂着——面板上就是「生成中」永远不结束。
    let timer = null;
    let timedOut = false;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      timedOut = false;
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        response = await doFetch(url, {
          method,
          headers: {
            accept: 'application/json',
            // 唯一的鉴权方式：x-key。带 Bearer 会被 401。
            'x-key': apiKey,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
        break;
      } catch (error) {
        clearTimeout(timer);
        const { kind, code } = classifyNetError(error, timedOut);
        process.stderr.write('[bfl] 请求失败 kind=' + kind + (code ? ' code=' + code : '') + '\n');
        if (kind === 'wait-timeout') {
          throw problem('BFL_TIMEOUT', `请求已发出，${Math.round(timeoutMs / 1000)} 秒内没有回话。`);
        }
        const retryable = kind === 'reset' || (kind === 'connect' && !DETERMINISTIC_CONNECT.test(code));
        if (retryable && attempt < NET_RETRY_DELAYS.length) {
          process.stderr.write('[bfl] ' + (code || kind) + '，第 ' + (attempt + 1) + ' 次重试\n');
          await delay(NET_RETRY_DELAYS[attempt]);
          continue;
        }
        if (kind === 'connect') {
          throw problem('BFL_UNREACHABLE', `连不上 api.bfl.ai${code ? '（' + code + '）' : ''}：${connectHint(code)}`);
        }
        throw problem('BFL_UNREACHABLE', `连接被中断${code ? '（' + code + '）' : ''}：出口线路抖了一下，已经重试 ${attempt} 次仍没成功。`);
      }
    }

    // body 读取不能只靠 abort：abort 要能传到 body 流上才行，而代理卡住时
    // 责任链往往断在中间环节。这里显式赛一道，保证「无论如何都会退出」。
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
        throw problem('BFL_TIMEOUT', `已经连上 api.bfl.ai 并拿到响应头（HTTP ${response.status}），但 ${Math.round(timeoutMs / 1000)} 秒内读不到内容。通常是代理转发响应体卡住：把代理换成 TUN / 系统代理模式再试。`);
      }
      throw problem('BFL_UNREACHABLE', `读取 BFL 的响应时中断（HTTP ${response.status}）。`);
    }
    clearTimeout(timer);
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    const detail = upstreamDetail(payload);

    if (response.status === 401 || response.status === 403) {
      throw problem('BFL_AUTH_FAILED', `BFL 拒绝了这把 Key（HTTP ${response.status}）${detail ? '：' + detail : '。'}API Key 要通过 x-key 传，确认没填成别家的。`);
    }
    if (response.status === 402) {
      throw problem('BFL_NO_CREDITS', `BFL 账户余额不足（HTTP 402）${detail ? '：' + detail : '。'}去 api.bfl.ai 充值后重试。`);
    }
    if (response.status === 404) {
      if (expect === 'poll') {
        throw problem('BFL_TASK_GONE', `BFL 那边查不到这个任务了（HTTP 404）${detail ? '：' + detail : '。'}`);
      }
      throw problem('BFL_MODEL_MISSING', `BFL 上找不到这个端点（HTTP 404）${detail ? '：' + detail : '。'}检查模型名，或地址是否少了 /v1。`);
    }
    if (response.status === 429) {
      throw problem('BFL_RATE_LIMITED', `BFL 限流（HTTP 429）${detail ? '：' + detail : '。'}同一把 Key 最多 24 个活跃任务，等一会儿再试。`);
    }
    if (response.status === 422) {
      throw problem('BFL_INVALID_REQUEST', `BFL 拒绝了这次请求的参数（HTTP 422）${detail ? '：' + detail : '。'}`);
    }
    if (!response.ok) {
      throw problem('BFL_REQUEST_FAILED', `BFL 返回 HTTP ${response.status}${detail ? '：' + detail : '。'}`);
    }
    if (!payload) throw problem('BFL_RESPONSE', 'BFL 返回了无法识别的响应。');
    return payload;
  }

  function pollingUrlOf(payload, taskId) {
    const raw = String(payload.polling_url || '').trim();
    if (!raw) return root + '/get_result?id=' + encodeURIComponent(taskId);
    // 文档说「务必使用返回的 polling_url」，但不同 SDK 返回的有时不带 id
    // （形如 https://api.bfl.ai/v1/get_result）。不带就自己补一个。
    if (/[?&]id=/.test(raw)) return raw;
    return raw + (raw.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(taskId);
  }

  // 提交响应里的 payload 只用来算 polling_url，不必留在 pending 里。
  function remember(taskId, meta) {
    const { payload, ...rest } = meta;
    pending.set(taskId, Object.assign({ pollingUrl: pollingUrlOf(payload, taskId) }, rest));
  }

  // 「选什么得什么」这条对面板是承诺，BFL 的 width/height 会被内部取整，
  // 差几像素也要补齐。
  async function fitTo(bytes, width, height) {
    const meta = await sharp(bytes).metadata();
    if (meta.width === width && meta.height === height) return sharp(bytes).png().toBuffer();
    return sharp(bytes).resize(width, height, { fit: 'fill' }).png().toBuffer();
  }

  async function submitGenerate(job) {
    const requested = parseRequestedSize(job.size) || { width: 1024, height: 1024 };
    const prompt = String(job.prompt || '').trim();
    if (!prompt) throw problem('PROMPT_REQUIRED', '请先输入画面描述。');
    // 和 vertex 一样：留空时自己摇一个并回传。用户拿到满意的一张，
    // 得知道用哪个种子才能再来一遍。
    const seed = Number.isInteger(job.seed) ? job.seed : Math.floor(Math.random() * 2147483647);
    const endpoint = root + '/' + encodeURIComponent(textModel);
    const body = {
      prompt,
      width: requested.width,
      height: requested.height,
      output_format: 'png',
      safety_tolerance: safetyTolerance(),
      seed
    };
    const payload = await request(endpoint, { method: 'POST', body });
    const taskId = String(payload.id || '');
    if (!taskId) throw problem('BFL_RESPONSE', 'BFL 没有返回任务编号。');
    remember(taskId, { payload, target: requested, composite: null, endpoint, requestBody: body });

    // BFL 一次只出一张，没有 n 参数。别让人以为多花了钱、只是没显示出来。
    const notes = [];
    if (Number(job.n) > 1) notes.push('这个通道一次只出一张，已按 1 张生成（候选数量 2~4 只有百炼/中转站支持）');
    if (hasChinese(prompt)) notes.push('FLUX 是英文模型，中文提示词通常效果打折');
    return { taskId, size: `${requested.width}*${requested.height}`, notice: notes.length ? notes.join('；') + '。' : '', seed,
      cost: { channel: 'bfl', endpoint, pixels: requested.width * requested.height, imageCount: 1 } };
  }

  // ── 扩图：四边像素直接告诉模型，不再「补比例→裁边」 ──────────────────────
  async function submitExpand(job, pngBytes, info) {
    const canvas = { width: info.width, height: info.height };
    // 和另外两家同一条规矩：Photoshop 传来的图层范围是几何真值，
    // alpha 反推只作备胎（照片边缘的半透明描边会让反推偏大）。
    let bounds = saneBounds(job.canvasBounds, canvas);
    if (!bounds) bounds = saneBounds(info.opaqueBounds, canvas);
    if (!bounds) {
      throw problem('NO_EXPAND_AREA', '画布上看不出清晰的「原图 + 透明扩展区」。请先把画布拉大、让原图贴住其中一侧后重试。');
    }
    // 图层范围本身是个矩形，但不等于「有像素的范围」：用户缩放/移动过图层、
    // 或图层边缘留了空白，按它裁出来的照片就会带一条透明边——那正是审核拦下来的东西。
    // 收紧之后四边偏移自动变大，画布尺寸不变，合成时只取条带，所以视觉上就是「多扩一点」。
    const declared = bounds;
    const tight = tightenToPixels(bounds, saneBounds(info.opaqueBounds, canvas));
    if (tight.left !== declared.left || tight.top !== declared.top || tight.right !== declared.right || tight.bottom !== declared.bottom) {
      process.stderr.write('[bfl] 照片框收紧：图层 ' + fmtRect(declared) + ' → 有像素的 ' + fmtRect(tight) + '\n');
    }
    bounds = tight;
    const offsets = {
      left: Math.max(0, Math.round(bounds.left)),
      top: Math.max(0, Math.round(bounds.top)),
      right: Math.max(0, Math.round(canvas.width - bounds.right)),
      bottom: Math.max(0, Math.round(canvas.height - bounds.bottom))
    };
    if (offsets.left + offsets.top + offsets.right + offsets.bottom === 0) {
      throw problem('NO_EXPANSION', '画布里没有需要扩展的区域。');
    }

    // 送出去的是「照片本身」，不是整张画布：画布里的透明区对模型没有意义，
    // 还会让它以为那些地方本来就有内容。
    // flatten 兜住照片内部的透明洞（描边、抠图残留）——带透明必被审核拦，实测过。
    const photo = await sharp(pngBytes)
      .extract({ left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top })
      .flatten({ background: '#ffffff' })
      .png().toBuffer();

    // 四边是这次调用的全部意义：模型只被允许往这四个方向长，中间那块在
    // 结构上就不归它管。少传任何一个，它就会把照片自己也重画一遍。
    const body = {
      image: photo.toString('base64'),
      left: offsets.left,
      top: offsets.top,
      right: offsets.right,
      bottom: offsets.bottom,
      output_format: 'png',
      safety_tolerance: safetyTolerance()
    };
    // 只有用户自己写了才发。框架给的默认提示词是中文，对 FLUX 是负分；
    // 而不写提示词时 expand 会按边缘自然延伸，反而更稳。
    const typed = String(job.prompt || '').trim();
    if (typed && typed !== DEFAULT_EXPAND_PROMPT) body.prompt = typed;

    const endpoint = root + EXPAND_PATH;
    const payload = await request(endpoint, { method: 'POST', body });
    const taskId = String(payload.id || '');
    if (!taskId) throw problem('BFL_RESPONSE', 'BFL 没有返回任务编号。');

    const strips = expandStrips(canvas.width, canvas.height, bounds);
    remember(taskId, {
      payload,
      endpoint,
      requestBody: body,
      target: canvas,
      // 契约：结果必须是画布尺寸、且只有新增区有像素。模型只负责画得像，
      // 裁切与接缝仍然交给 composeExpand——它现在从「擦屁股」变成「保险」。
      composite: {
        window: { left: 0, top: 0, right: canvas.width, bottom: canvas.height },
        strips,
        frame: canvas,
        bounds,
        base: pngBytes
      }
    });
    process.stderr.write('[bfl] 扩图 画布 ' + canvas.width + 'x' + canvas.height
      + ' 照片 ' + (bounds.right - bounds.left) + 'x' + (bounds.bottom - bounds.top)
      + ' 四边 ' + offsets.left + '/' + offsets.top + '/' + offsets.right + '/' + offsets.bottom
      + '，合成只取新增条带 ' + strips.length + ' 条\n');
    const notice = typed && typed !== DEFAULT_EXPAND_PROMPT && hasChinese(typed)
      ? 'FLUX 是英文模型，中文提示词通常效果打折；扩图时不写提示词往往更稳。'
      : '';
    return { taskId, size: canvas.width + '*' + canvas.height, notice,
      cost: { channel: 'bfl', endpoint, pixels: canvas.width * canvas.height, imageCount: 1 } };
  }

  // ── 选区编辑：真 mask，不是矩形贴回 ────────────────────────────────────
  async function submitFill(job, pngBytes, maskBytes, canvas, info) {
    // 透明区会被 BFL 判成 Content Moderated，带 alpha 通道（哪怕全不透明）会让它按 RGBA
    // 解码而顶到 20MB。两者都在 fitFillUpload 里处理：无条件去 alpha + 超限转 JPEG。
    const upload = await fitFillUpload(pngBytes);
    const sendBytes = upload.bytes;
    if (upload.formatChanged) process.stderr.write('[bfl] 底图 ' + (pngBytes.length / 1048576).toFixed(1)
      + 'MB → ' + (sendBytes.length / 1048576).toFixed(1) + 'MB（' + upload.steps.join('+')
      + '，避开 20MB 上限；尺寸不变，mask 对齐）\n');
    // raw 超过 BFL 硬限时，转 JPEG 压的只是传输字节，解码后 still 超限——上游多半会 422。
    // 与其让用户对着「file size exceeds 20MB」猜是自己哪里配错，不如提前说清是画布太大，
    // 并给出可执行的下一步（缩小选区 / 分块）。这只加提示，不拦截，避免误伤上游口径变化。
    let fillNotice = '';
    if (upload.overRawLimit) {
      fillNotice = '本次底图按像素算约 ' + (upload.rawRgbBytes / 1048576).toFixed(0)
        + 'MB，超过 BFL 20MB 上限，可能被上游拒绝；建议缩小选区或分块编辑。';
      process.stderr.write('[bfl] 警告：' + fillNotice + '\n');
    }
    const body = {
      image: sendBytes.toString('base64'),
      mask: maskBytes.toString('base64'),
      prompt: String(job.prompt || '').trim() || DEFAULT_FILL_PROMPT,
      output_format: 'png',
      safety_tolerance: safetyTolerance()
    };
    const endpoint = root + FILL_PATH;
    const payload = await request(endpoint, { method: 'POST', body });
    const taskId = String(payload.id || '');
    if (!taskId) throw problem('BFL_RESPONSE', 'BFL 没有返回任务编号。');
    // maskBytes 留着：下载时按它复合回原图，保证 mask 外零变化。
    remember(taskId, { payload, endpoint, requestBody: body, target: canvas, composite: null, maskBytes, baseBytes: pngBytes });
    return { taskId, size: canvas.width + '*' + canvas.height, notice: fillNotice,
      cost: { channel: 'bfl', endpoint, pixels: canvas.width * canvas.height, imageCount: 1 } };
  }

  async function submit(job) {
    if (!job || !job.operation) throw problem('INVALID_JOB', '任务缺少操作类型。');
    if (job.operation === 'generate' && !job.image) return submitGenerate(job);

    if (!job.image) throw problem('IMAGE_MISSING', '这个操作需要底图。');
    const { pngBytes, maskBytes } = await decodeCapture(job.image, job.mask);
    const info = await inspectImage(pngBytes, maskBytes);
    const canvas = { width: info.width, height: info.height };

    // 扩图：有明确的「照片框 + 画布框」时走原生 expand。
    // 用 mask 扩图（选区落在透明区）时没有照片框语义，落到 fill 分支处理。
    if (job.operation === 'expand' && !maskBytes) return submitExpand(job, pngBytes, info);

    // 剩下的都走 fill：只要 PS 给了 mask 就原样交给模型；没给（editWhole）
    // 就造一张全白 mask，等价于整张重绘。
    const mask = maskBytes || await sharp({
      create: { width: info.width, height: info.height, channels: 3, background: '#ffffff' }
    }).png().toBuffer();
    process.stderr.write('[bfl] ' + (job.operation === 'editMasked' ? '选区编辑' : job.operation === 'expand' ? '选区扩图' : '整图编辑')
      + ' 画布 ' + info.width + 'x' + info.height
      + (maskBytes ? '，mask 交给模型（mask 外不动）' : '，全白 mask（整张重绘）') + '\n');
    return submitFill(job, pngBytes, mask, canvas, info);
  }

  async function poll(taskId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(taskId || ''))) throw problem('INVALID_TASK_ID', '任务编号无效。');
    const meta = pending.get(taskId);
    if (!meta) throw problem('RESULT_UNAVAILABLE', '任务已失效，请重新生成。');

    // 轮询失败不该判定任务失败：网络抖一下，下一轮继续问就是了。
    // 真的连不上会由 jobManager 的总超时兜住，不会无限转。
    let payload;
    try {
      payload = await request(meta.pollingUrl, { timeoutMs: pollTimeoutMs, expect: 'poll' });
    } catch (error) {
      if (error && (error.code === 'BFL_UNREACHABLE' || error.code === 'BFL_TIMEOUT')) {
        process.stderr.write('[bfl] 轮询失败（' + error.code + '），继续等下一轮\n');
        return { status: 'RUNNING', resultUrls: [], errorCode: null };
      }
      // 查不到任务时先别急着判死：实测刚提交的那几秒，区域集群之间会短暂对不上，
      // 同一个 id 一会儿 404 一会儿 Pending。连查三次都没有，才认定它真没了。
      if (error && error.code === 'BFL_TASK_GONE') {
        meta.goneCount = (meta.goneCount || 0) + 1;
        if (meta.goneCount <= 2) {
          process.stderr.write('[bfl] 第 ' + meta.goneCount + ' 次查不到任务，再等等\n');
          return { status: 'RUNNING', resultUrls: [], errorCode: null };
        }
        throw problem('BFL_TASK_GONE', 'BFL 上查不到这个任务了（连续三次）。可能已过期，请重新生成。');
      }
      throw error;
    }

    const status = String(payload.status || '');
    if (status === 'Ready') {
      const sample = String((payload.result && payload.result.sample) || '');
      if (!sample) throw problem('EMPTY_RESULT', 'BFL 说完成了，但没有给出图片地址。');
      // 把几何说明搬到 sample 名下，download 才能按那个 URL 找到它。
      pending.set(sample, meta);
      return { status: 'SUCCEEDED', resultUrls: [sample], errorCode: null };
    }
    if (MODERATED.has(status)) {
      // 出图审核，不是「这张图违法」。BFL 的档位 0~6，2 档对正常产品稿明显过紧：
      // 实测同一张「手持遥控器拍产品界面」的照片，2 档连拦两次，6 档一次就过。
      // 让用户去读「换一张底图」的提示只会白费功夫，所以这里自动放宽到最松档重来一次。
      // 只重试一次：再拦就说明确实不该出这张图，那时候报错才有意义。
      if (!meta.moderationRetry && meta.endpoint && meta.requestBody) {
        meta.moderationRetry = true;
        try {
          const again = await request(meta.endpoint, { method: 'POST', body: { ...meta.requestBody, safety_tolerance: 6 } });
          const nextId = String(again.id || '');
          if (nextId) {
            process.stderr.write('[bfl] 审核拦下（' + status + '），放宽到 6 档重试一次\n');
            meta.pollingUrl = pollingUrlOf(again, nextId);
            meta.goneCount = 0;
            return { status: 'RUNNING', resultUrls: [], errorCode: null };
          }
        } catch (error) {
          // 重试失败不影响结论：下面照常报「被拦」，用户该换图还是换图。
          process.stderr.write('[bfl] 放宽档位重试没成功：' + (error && error.message) + '\n');
        }
      }
      return { status: 'FAILED', resultUrls: [], errorCode: 'BFL_MODERATED', errorMessage: `BFL 的安全策略拦下了这次生成（${status}）。放宽档位重试过仍然被拦，换一种描述或换一张底图再试。` };
    }
    if (TERMINAL_FAILURES.has(status)) {
      const detail = upstreamDetail(payload) || String(payload.error || '');
      return { status: 'FAILED', resultUrls: [], errorCode: 'BFL_TASK_FAILED', errorMessage: `BFL 生成失败（${status}）${detail ? '：' + detail : '。'}` };
    }
    return { status: status === 'Pending' || status === 'Queued' ? 'PENDING' : 'RUNNING', resultUrls: [], errorCode: null };
  }

  // 只保留 mask 内的像素，其余用原图。比矩形贴回精确，且保证 mask 外零变化。
  // 灰度 mask 要变成 alpha 通道才能做 dest-in，所以先把它 join 到一张白底 RGB 上。
  async function compositeThroughMask(baseBytes, patchedBytes, maskBytes) {
    const meta = await sharp(maskBytes).metadata();
    const width = meta.width;
    const height = meta.height;
    const gray = await sharp(maskBytes).greyscale().raw().toBuffer();
    const alphaMask = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .joinChannel(gray, { raw: { width, height, channels: 1 } })
      .png().toBuffer();
    const cut = await sharp(patchedBytes)
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .composite([{ input: alphaMask, blend: 'dest-in' }])
      .png().toBuffer();
    return sharp(baseBytes).composite([{ input: cut }]).png().toBuffer();
  }

  async function download(url) {
    const sample = String(url || '');
    if (!/^https?:\/\//i.test(sample)) throw problem('RESULT_URL', '结果地址无效。');
    const meta = pending.get(sample);

    let response;
    try {
      // 签名链接不需要 x-key，带上的话反而可能被 CDN 拒。
      // 超时交给客户端自身（body 在返回前已经读完，不会有「读到一半挂住」）。
      response = await doFetch(sample, { headers: { accept: 'image/*' }, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    } catch (error) {
      const code = causeCode(error);
      throw problem('RESULT_DOWNLOAD', `结果图下载失败${code ? '（' + code + '）' : ''}：签名链接 10 分钟内有效，过期就需要重新生成。`);
    }
    if (!response.ok) {
      throw problem('RESULT_DOWNLOAD', `结果图下载失败（HTTP ${response.status}）：签名链接 10 分钟后就失效。`);
    }
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw problem('RESULT_DOWNLOAD', '结果图无法读取。'); }
    if (!bytes.length) throw problem('RESULT_DOWNLOAD', '结果图是空的。');

    try {
      if (meta && meta.composite) {
        // composeExpand 的前提是「source 与 frame 同尺寸」。BFL 的返回尺寸
        // 可能被内部取整，这里先补齐再合成，否则条带会整体偏移。
        const frame = meta.composite.frame;
        const sized = await fitTo(bytes, frame.width, frame.height);
        return await composeExpand(sized, meta.composite);
      }
      if (meta && meta.maskBytes) return await compositeThroughMask(meta.baseBytes, bytes, meta.maskBytes);
      if (meta && meta.target) return await fitTo(bytes, meta.target.width, meta.target.height);
      return await sharp(bytes).png().toBuffer();
    } catch (error) {
      if (error && error.code) throw error;
      throw problem('RESULT_IMAGE', '结果图像无法读取。');
    }
  }

  async function listModels() {
    return TEXT_MODELS.slice();
  }

  return { submit, poll, download, listModels, model: textModel, root };
}

module.exports = {
  createBflProvider,
  isBflBaseUrl,
  isBflChannel,
  bflRoot,
  modelFromBaseUrl,
  parseRequestedSize,
  hasChinese,
  connectHint,
  TEXT_MODELS,
  DEFAULT_TEXT_MODEL,
  DEFAULT_BASE_URL,
  FILL_PATH,
  EXPAND_PATH
};
