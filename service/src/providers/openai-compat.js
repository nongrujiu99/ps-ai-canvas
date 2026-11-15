'use strict';

// OpenAI 兼容中转站供应商。
//
// 走标准 Images API：
//   - 有图要改 → POST /v1/images/edits（multipart，可带 mask）
//   - 纯文字出图 → POST /v1/images/generations（JSON）
// 返回可能是 {data:[{b64_json}]}、{data:[{url}]} 或 {images:[...]}，
// 三种都接，统一收敛成 Buffer 交给外层「提交—轮询—下载」。
//
// 与 aliyun.js 最大的不同：这里**有 mask**。
// OpenAI 的语义是「mask 里透明的像素 = 需要重绘的区域」，正好对应扩图要补的边缘，
// 所以扩图不再需要靠「预填充 + 期望模型别乱动」来间接约束，而是直接告诉它
// 哪块能动、哪块不能动。这也是当初想换 GPT 系列的唯一实质理由。
//
// 代价：尺寸能力取决于中转和模型。gpt-image 系列只有 1024²/1024×1536/1536×1024 三档，
// 3074 宽的画布必然要缩放。所以这里做了尺寸降级链，并且把「模型实际返回的尺寸」
// 一路缩回画布尺寸，保证 CEP 侧 applyExpand 拿到的永远是画布大小的图。

const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { decodeCapture, inspectImage, buildExpandInput } = require('../image-inspection');
const { problem } = require('../contract');
const { createTtlMap } = require('../ttl-map');
const { composeExpand, expandStrips, extensionFidelity, saneBounds, snapToAllowedSize } = require('../expand-compose');
const { buildExpandPrompt } = require('../expand-prompt');

function providerError(code, message) {
  return problem(code, message);
}

// 常见档位。中转若支持任意尺寸会在第一步「精确尺寸」就成功，走不到这里。
const DEFAULT_ALLOWED_SIZES = ['1536x1024', '1024x1536', '1024x1024', '1792x1024', '1024x1792', '2048x1152', '1152x2048'];

// 上游池可能按尺寸分档：实测某中转的 gpt-image-2.6-flare 在 1536 档返回 200，
// 一旦到 2048 档就报 503 "10k pool upstream unavailable"——同一个 key、同一张图、
// 同一个 prompt，唯一变量是尺寸。所以「上游不可用」不能一律当成站方挂了：
// 当请求尺寸超过这个安全档时，先降一档再试，比让用户对着红字发呆有用得多。
const SAFE_FALLBACK_SIDE = 1536;

// 请求被对面掐断的错误码。ECONNRESET 是请求已经发出去、对面读到一半把连接关了——
// 大图上传被网关丢弃就是这种表现，值得重发一次。
const RESET_CODE = /^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED|ERR_STREAM_PREMATURE_CLOSE)$/;

// 连都没连上的错误码。以前这里只有 RESET_CODE 会重试，理由是「DNS 失败、连接被拒
// 是硬错误，重试没意义」。这个判断是错的，代价已经付过一次：
//   11:02 那次扩图，日志里是「连接被重置」→ 重试一次 → ECONNREFUSED → 判失败。
// 同一条链路几分钟后再测，连发 5 次全部返回 401（通的）。也就是说 ECONNREFUSED
// 在这里不代表「地址写错」，而是「这一瞬间连不出去」——CDN 节点抖动、本机 NAT
// 表被打满、公司网关掐掉新连接，都是这个表现。它的正确处置是隔几秒再连一次，
// 而不是把用户两分钟的等待和一次额度作废掉。
const CONNECT_CODE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|UND_ERR_CONNECT_TIMEOUT)$/;

// 记住「这个渠道这个模型最大能吃到多大」。降档一旦成功，后续任务直接按安全档发请求，
// 不必每次都先撞一次墙——那一次要白等十秒左右，用户看到的就是「按钮转了十几秒才出图」。
// 存在进程内存里：服务重启后重新探一次，等于给渠道一个自愈的机会。
const knownCeilings = new Map();
// 哪些渠道被证实会「改写」我们发的自定义尺寸（要 1536x1520 回 2834x2220）。
// 一旦踩到，后续扩图直接走标准档，不再拿两次必败的请求去试。
const sizeRewrites = new Set();

// 中转站的 b64 字段常常是整条 data URL。剥掉前缀再 base64 解码，
// 否则前缀字符会被当成有效 base64 输入，解出一张无法解析的"图"。
function stripDataUrl(value) {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value;
}

// 有的渠道（如 Gemini 系、Nano-banana）不用像素尺寸，而是「档位 + 宽高比」。
// 4K 档 ≈ 4096 边长，对 3074×2560 这种画布比固定 1536 档清晰一个量级。
const TIER_ORDER = ['4K', '2K', '1K'];

// Gemini 那类模型接受的宽高比是个封闭集合，画布比例再怪也只能就近取一档。
// 数组按「常用程度」排，同分时靠前的优先（近方形的画布很多，1:1 先试）。
const STANDARD_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '5:4', '4:5', '21:9'];

// 档位入口和成片校验共用同一条比例容差。以前入口是 4%、校验是 5%：
// 2048×2844 对 3:4 的偏差是 4.07%，于是成片本来能过，请求却先被踢到
// 自定义像素池（gemini-...-1104x1536），撞上中转站没有节点的路由。
const MAX_ASPECT_SKEW = 0.05;

function ratioValue(ratio) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ratio || ''));
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0;
}

// 画布比例 → 最接近的标准宽高比。
//
// 这一步以前是让用户在渠道设置里手填一个 aspect_ratio，实际上没人会为每张画布
// 去改一次配置；填错了就是 38% 的比例偏差、整张重画。改成自动推导之后，
// 「档位模式」才真正可用：4K + 精确比例 = 又清楚又接得上。
//
// 用对数比误差而不是减法：2:1 和 1:2 的偏差在几何上是等距的，减法会偏向横图。
function aspectForCanvas(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return { ratio: '1:1', skew: 0 };
  const target = canvas.width / canvas.height;
  let best = STANDARD_RATIOS[0];
  let bestError = Infinity;
  for (const ratio of STANDARD_RATIOS) {
    const error = Math.abs(Math.log(ratioValue(ratio) / target));
    if (error < bestError) { bestError = error; best = ratio; }
  }
  return { ratio: best, skew: bestError };
}

// 按宽高比算一个「长边 = side」的尺寸，并对齐到 16 的倍数。
// 档位模式下底稿就按这个尺寸做：它的比例必须等于 aspect_ratio，
// 否则模型看到的留白占比和最终合成的几何对不上，接缝会错开几十像素。
function aspectBox(ratio, side = SAFE_FALLBACK_SIDE) {
  const value = ratioValue(ratio) || 1;
  const width = value >= 1 ? side : side * value;
  const height = value >= 1 ? side / value : side;
  const snap = (n) => Math.max(16, Math.round(n / 16) * 16);
  return { width: snap(width), height: snap(height) };
}

// 扩图的提示词搬到了 ../expand-prompt：它跟百炼共用同一套，
// 而且「必须画出内容 / 不许涂成一片白」这类约束一旦写错，扩展区就会变成一块白雾。
const DEFAULT_FILL_PROMPT = '按原图的材质、光线和景深补全被遮罩的区域，与周围自然衔接。';

// 扩展区被模型原样交回来时，换一种「请求形态」再试。
//
// 以前是「同一形态重试一次」——实测收益很低：模型不听话时，几乎总是同一个错法，
// 换个形容词解决不了。真正有效的是换问法：带遮罩的局部重绘、不带遮罩的底稿续画、
// 只给原照片让它输出更大的构图，这三者在模型眼里是三个不同的任务，
// 总有一个能落到位（尤其是中转站把 mask 直接丢掉的时候，后两种才是唯一出路）。
//
// 三次是上限：每次都是一次真实的 API 调用和几十秒等待，再多就不如让用户自己重试。
const EXPAND_ATTEMPTS = 3;
const EXPAND_SHAPES = ['masked', 'padded', 'bare'];

function normalizeBaseUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw providerError('INVALID_ENDPOINT', '接口地址无效，需要形如 https://api.example.com/v1 的地址。');
  }
  if (!/^https?:$/.test(url.protocol)) throw providerError('INVALID_ENDPOINT', '接口地址必须是 http 或 https。');
  let path = url.pathname.replace(/\/+$/, '');
  // 大多数中转的基址已经带 /v1；没带就补上（少数聚合站把版本号放在别处，
  // 这种情况让用户直接把完整前缀填进来）。
  if (!/\/v\d+[a-z0-9]*$/i.test(path)) path += '/v1';
  return url.origin + path;
}

function isSizeError(message) {
  return /size|resolution|dimension|width|height|尺寸|分辨率/i.test(String(message || ''));
}

// 「上游不可用」和「请求有问题」要分开：前者等一会儿重试就好，后者改参数才有用。
// 中转站的措辞五花八门（"10k pool upstream unavailable"、"no available channel"、
// "service temporarily overloaded"），但都指向同一件事——请求根本没走到模型，
// 是站方那侧的池子没容量了。这类失败通常既不出图也不扣费，重试代价极低。
const UPSTREAM_TEXT = /upstream|no available|unavailable|pool|overload|over capacity|temporarily|try again later|service busy|rate limit|too many requests|系统繁忙/i;

function isUpstreamError(status, message) {
  if (status >= 500 || status === 429) return true;
  return UPSTREAM_TEXT.test(String(message || ''));
}

// 「池子没容量」比「上游出错」更具体一层：请求根本没走到模型，只是中转站按
// 「模型 + 尺寸」去上游池里挑节点时，能接这个组合的节点恰好没有。
// 这类失败有很强的随机性——同一个请求上午过、下午不过，隔一会儿又过。
// 因为它们不扣费也不出图，重发的代价只是一次往返，值得自动多试几次；
// 而其他 5xx 有可能是请求已经开始处理才出错的，多试会出两张图、扣两次费，不能这么干。
// 措辞是中英混杂的：同一个站会回 "no available channel"，也会回
// 「所有分组对于模型 xxx 无可用渠道」。**中文这一支最初漏了**，于是中文站点的池子失败
// 走进了「其他上游失败」的预算（1 次、1.5 秒），日志能证明：一次中文 503 只用了 5 秒就
// 收尾，重试等于没发生。所以判据不能只认英文，还得先按状态码兜一层。
const POOL_TEXT = /no available|unavailable|pool|capacity|overload|busy|rate limit|too many requests|无可用|没有可用|渠道不可用|繁忙|负载|超载|排队|稍后重试|访问量过大/i;

function isPoolError(status, message) {
  // 网关级的三个码都说明请求没走到模型：502 上游节点连不上、503 没容量、504 网关等超时。
  // 真正要小心的是 500——它可能是模型处理到一半才报的错，重发会多出一张图、多扣一次费。
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return POOL_TEXT.test(String(message || ''));
}

// 中转站在错误正文里塞了 request id，还有「请检查模型是否存在」这类写给管理员看的话。
// 原样贴进面板要占四五行的位置，把真正有用的那半句挤没了。截断到一句，并去掉 id。
function trimProviderDetail(text, limit = 90) {
  const out = String(text || '')
    .replace(/\(?\s*request id:\s*[A-Za-z0-9_-]+\s*\)?/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length <= limit) return out;
  return out.slice(0, limit).trim() + '…';
}

// 内容安全拦截：中转站用 451，正文是 "rejected by the content safety policy"；
// Gemini 侧自己的安全终止则表现为「没出图」，正文带 finish_reason=17 或
// "returned no image"。两处措辞不同，但都表示「这次请求被判定不能出图」，
// 换一种问法（换形态、换措辞）往往就能过，所以要和「参数错」「渠道挂」区分开。
const POLICY_TEXT = /content safety|safety policy|safety system|prohibited|finish_reason|returned no image|blocked/i;

function isPolicyBlock(error) {
  if (!error) return false;
  if (error.httpStatus === 451) return true;
  return POLICY_TEXT.test(String(error.providerMessage || error.message || ''));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 报错里只放域名，不放整条 URL：结果图链接通常带签名/令牌，
// 原样写进日志和面板文案等于把凭证抄了一遍。
function safeHost(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '未知域名';
  }
}

// undici 的 fetch 失败只给一句 "fetch failed"，真正的原因藏在 error.cause 里
// （ECONNRESET / ENOTFOUND / UND_ERR_SOCKET / CERT_HAS_EXPIRED…）。
// 不把它挖出来，排查就只能在「地址对不对、网通不通」上打转——而那两个往往都是好的。
function causeCode(error) {
  const cause = error && error.cause;
  if (!cause) return '';
  if (cause.code) return cause.code;
  if (Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code) return cause.errors[0].code;
  if (cause.message) return String(cause.message).slice(0, 80);
  return '';
}

// 上传体积上限。中转站/网关对 multipart 体积的限制普遍在 10MB 上下，
// 而一张 2672×2560 的照片存成 PNG 就有 10~15MB，正好卡在这条线上：
// 表现是请求发出后几秒被断开，报「无法连接图像接口」——看着像网络问题，其实是被拒。
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

async function shrinkForUpload(bytes, maxBytes = UPLOAD_MAX_BYTES) {
  if (bytes.length <= maxBytes) return { bytes, type: 'image/png', name: 'image.png' };
  // 只降质量不降尺寸：模型本来就要重绘边缘，尺寸掉了才是真的伤画质。
  // 透明区域压平到白色——扩图的预填充图本来就不透明，只有走泛化编辑时才会遇到带 alpha 的图。
  for (const quality of [92, 85, 78]) {
    const jpeg = await sharp(bytes).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
    if (jpeg.length <= maxBytes) return { bytes: jpeg, type: 'image/jpeg', name: 'image.jpg' };
  }
  const fallback = await sharp(bytes).flatten({ background: '#ffffff' }).jpeg({ quality: 70 }).toBuffer();
  return { bytes: fallback, type: 'image/jpeg', name: 'image.jpg' };
}

// 把「这次请求了多大一张图」写进错误里。用户看到的红字只有一句 "10k pool"，
// 无从判断是自己图太大还是站方挂了；带上尺寸和像素量，才好做减法（换小图/换模型）。
function sizeNote(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ''));
  if (!match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  const mp = Math.round((width * height) / (1024 * 1024) * 10) / 10;
  return `本次请求 ${width}×${height}（约 ${mp} MP）。`;
}

// 判断这个尺寸是否越过了「安全档」，越过才值得降级重试。
function exceedsSide(size, side) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ''));
  if (!match) return false;
  return Math.max(Number(match[1]), Number(match[2])) > side;
}

// AbortSignal.timeout() 抛的是 DOMException(TimeoutError)；不同 Node 版本/代理层
// 也可能抛带 ABORT_ERR 的普通 Error，两种都要认。
function isTimeout(error) {
  if (!error) return false;
  return error.name === 'TimeoutError' || error.code === 'ABORT_ERR' || error.name === 'AbortError';
}

// 同步出图的接口（中转站基本都是）会在一个请求里等着出图，画布越大越慢。
// 以前写死 120 秒，2600×2560 这种图经常刚过两分钟就被掐断，而且掐断后报的是
// 「无法连接接口」——用户按这个提示去查网络、换地址，怎么查都没问题。
// 现在默认 5 分钟，且超时单独报 PROVIDER_TIMEOUT，跟真的连不上区分开。
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// 上游抖动时的自动重试。只重试一次：中转站的池子故障要么是瞬时抖动（重试就过），
// 要么是整段时间挂掉（重试十次也一样，只会让用户多等）。延时放在 1.5 秒，
// 是因为这类错误多半来自负载均衡把请求打到了刚下线、还没摘干净的节点上。
const DEFAULT_UPSTREAM_RETRIES = 1;
const DEFAULT_UPSTREAM_RETRY_DELAY_MS = 1500;

// 池子类的重试预算单独一套，比上面宽松得多。
//
// 依据是实测：同一个 1104x1536 请求连发 4 次，4 次全过、每次 20 秒左右；
// 而用户遇到的失败是「今天过、明天不过」——说明这个组合在池子里有容量，只是时有时无。
// 原来只补一次、固定等 1.5 秒，等于在同一个坏时刻又敲了一次门，几乎必然还是坏。
//
// 退避取 2 / 6 / 12 秒，合计约 20 秒，正好等于「用户自己等一会儿、再手动点一次重试」
// 的时间。区别是不用他动手，也不用把图重新上传一遍（编辑一次要传几 MB）。再多就变成
// 陪着站方一起挂了：池子真空的时候，等一分钟和等二十秒的结果一样。
const DEFAULT_POOL_RETRIES = 3;
const DEFAULT_POOL_RETRY_DELAYS = [2000, 6000, 12000];
// 连不上时多给两次机会，退避 3s / 6s。理由见 CONNECT_CODE 的注释：
// ECONNREFUSED 在这条链路上是抖动而不是配置错误，实测几分钟后就恢复正常。
const DEFAULT_CONNECT_RETRIES = 2;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 3000;

// 结果图的重试要远比接口本身宽松。实测同一个图床域名（Cloudflare 后面）连续连 8 次，
// 有 1 次 ECONNRESET、curl 侧还有 2 次卡在 TLS 握手——链路抖动是常态而不是故障。
// 而这一次失败的代价特别高：图已经出出来了、钱已经花了、还等了四五分钟，
// 却因为最后一步下载被掐而全部作废，用户只能从头再来一遍。
//
// 次数从 5 提到 8、退避从「500ms × 次数」改成「400ms 起翻倍、封顶 6s」，
// 是因为看过真实数据：日志里 18 次下载失败，多数在第 2 次就成功，有一批要熬到第 5 次，
// 还有一次五次全败（11 月 12 日那次，71 秒后报错）。第 5 次全败的那次如果再给三次、
// 每次隔 3~6 秒，多半就过去了。总等待从约 7.5 秒拉长到约 25 秒，比重新生成便宜得多。
const DEFAULT_DOWNLOAD_ATTEMPTS = 8;
const DEFAULT_DOWNLOAD_RETRY_DELAY_MS = 400;
// 下载超时单独一套：图片 CDN 通常很快，卡住就是卡住了，没必要陪着等 5 分钟。
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60 * 1000;

function createOpenAiCompatProvider({ fetchImpl = fetch, baseUrl, apiKey, model = 'gpt-image-1', allowedSizes = DEFAULT_ALLOWED_SIZES, maxPixels = 4 * 1024 * 1024, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, imageField = 'image', maskField = 'mask', sizeMode = 'pixels', sizeParam = 'size', tierParam = 'image_size', aspectRatio, upstreamRetries = DEFAULT_UPSTREAM_RETRIES, upstreamRetryDelayMs = DEFAULT_UPSTREAM_RETRY_DELAY_MS, poolRetries = DEFAULT_POOL_RETRIES, poolRetryDelays = DEFAULT_POOL_RETRY_DELAYS, connectRetries = DEFAULT_CONNECT_RETRIES, connectRetryDelayMs = DEFAULT_CONNECT_RETRY_DELAY_MS, downloadAttempts = DEFAULT_DOWNLOAD_ATTEMPTS, downloadRetryDelayMs = DEFAULT_DOWNLOAD_RETRY_DELAY_MS, downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS } = {}) {
  const root = normalizeBaseUrl(baseUrl);
  if (typeof apiKey !== 'string' || !apiKey) throw providerError('MISSING_API_KEY', '请先配置接口密钥。');
  if (!model) throw providerError('MISSING_MODEL', '请先配置模型名称。');

  // 同步出图的接口没有任务号，这里自造一个，把结果暂存。
  // 外层 jobManager 的「提交—轮询—下载」架构完全不用改。
  // 用带过期的表：取消的任务不会走到 download，纯 Map 会把这几 MB 永远留着。
  const pending = createTtlMap();

  async function callApi(path, init, timeoutMs = requestTimeoutMs) {
    let lastStatus = 0;
    let lastMessage = '';
    // 循环上界要取三者的较大值：连接类失败和池子类失败允许重试的次数都比
    //「其他上游失败」更多。只写 upstreamRetries 的话，多出来的预算根本不会发生。
    const maxAttempts = Math.max(upstreamRetries, connectRetries, poolRetries);
    // 重试只对「上游不可用」生效。尺寸被拒、鉴权失败、参数非法都不会重试——
    // 那些是确定性的，重发一模一样的请求只会得到一模一样的拒绝。
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      let response;
      try {
        response = await fetchImpl(root + path, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) }
        });
      } catch (error) {
        // 超时和「连不上」是两种完全不同的故障，处理方式也相反：
        // 一个要等更久或换更小的图，一个要查地址和网络。混成一句话会把人带偏。
        if (isTimeout(error)) {
          throw providerError('PROVIDER_TIMEOUT', `生成超时：接口 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果。画布越大耗时越长，可以把扩图比例调小或换更快的渠道。`);
        }
        const code = causeCode(error);
        const causeMessage = String((error && error.cause && error.cause.message) || '');
        // 这一行是排查「到底断在哪」的唯一证据：没有它，用户看到的
        // 「无法连接图像接口」和「上游不可用」在日志里长得一模一样。
        process.stderr.write(`[provider] ${path} 网络失败: ${error && error.name}: ${error && error.message}${code ? ' cause=' + code : ''}\n`);
        // "socket hang up" / "other side closed" 是 Node 对同一个 reset 的另一种措辞；
        // TLS 握手失败常常没有 code，只有一句 "disconnected before secure TLS connection"。
        const reset = RESET_CODE.test(code) || /socket hang up|other side closed/i.test(causeMessage);
        const connect = !reset && (CONNECT_CODE.test(code) || /handshake|secure TLS connection|getaddrinfo/i.test(causeMessage));
        const retries = connect ? connectRetries : upstreamRetries;
        const failure = providerError('PROVIDER_NETWORK', connect
          ? `连不上图像接口${code ? '（' + code + '）' : ''}：域名能解析，但连接没能建立。这通常是本机网络、代理或节点抖动，不是插件也不是模型的问题。已经自动重试 ${connectRetries} 次仍然不行。换个网络（或关掉/打开代理）、或者过几分钟再试。`
          : `连接图像接口时被切断${code ? '（' + code + '）' : ''}：请求发出去之后对端把连接关了，已自动重试 ${upstreamRetries} 次。链路抖动多半重试就好，连续出现请换个网络环境再试。`);
        failure.causeCode = code;
        failure.reset = reset;
        failure.connect = connect;
        // 重试两类错误，但节奏不同：
        // - 被重置：连接是通的，立刻重发就够（1.5 秒），多等只会让用户干着急。
        // - 连不上：立刻重发必然还是连不上，要让开抖动窗口，按 3s/6s 递增退避。
        if ((reset || connect) && attempt < retries) {
          const wait = connect ? connectRetryDelayMs * (attempt + 1) : upstreamRetryDelayMs;
          process.stderr.write(`[provider] ${path} ${connect ? '连不上' : '连接被重置'}，${wait}ms 后重试（第 ${attempt + 1}/${retries} 次）\n`);
          await delay(wait);
          continue;
        }
        throw failure;
      }
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (response.ok) {
        if (!payload) throw providerError('PROVIDER_RESPONSE', '图像接口返回了无法识别的响应。');
        // 中转站可能把请求路由给别的模型（请求 gemini，响应里 model 字段却是别家）。
        // 这是「同样参数时好时坏」的头号嫌疑，必须每次留痕，否则只能靠猜。
        if (payload.model && payload.model !== model) {
          process.stderr.write('[provider] 注意：请求 ' + model + '，响应 model=' + payload.model + '\n');
        }
        return payload;
      }
      lastStatus = response.status;
      lastMessage = (payload && (payload.error && (payload.error.message || payload.error.code) || payload.message)) || `HTTP ${response.status}`;
      // 池子没容量时多试几次，且退避要长到能跨过「节点被摘掉再补上」的那个窗口；
      // 其他上游失败仍只补一次，因为它们可能是请求已经开始处理才报的错。
      const pool = isPoolError(lastStatus, lastMessage);
      const budget = pool ? poolRetries : upstreamRetries;
      if (attempt < budget && (pool || isUpstreamError(lastStatus, lastMessage))) {
        const wait = pool
          ? (attempt < poolRetryDelays.length ? poolRetryDelays[attempt] : poolRetryDelays[poolRetryDelays.length - 1] || upstreamRetryDelayMs)
          : upstreamRetryDelayMs;
        if (pool) {
          process.stderr.write('[provider] ' + path + ' 池子没容量（HTTP ' + lastStatus + '），'
            + wait + 'ms 后重试（第 ' + (attempt + 1) + '/' + budget + ' 次）\n');
        }
        await delay(wait);
        continue;
      }
      break;
    }
    if (isUpstreamError(lastStatus, lastMessage)) {
      const error = providerError('PROVIDER_UPSTREAM', `图像接口上游暂时不可用：${String(lastMessage).slice(0, 160)}`);
      error.httpStatus = lastStatus;
      // 原文单独留一份。上层会把 message 改写成给人看的话，但排查时
      // "10k pool" 这种词才是唯一线索，不能丢。
      error.providerMessage = String(lastMessage).slice(0, 160);
      throw error;
    }
    const error = providerError('PROVIDER_REQUEST_FAILED', `图像接口请求失败：${String(lastMessage).slice(0, 200)}`);
    error.sizeRejected = isSizeError(lastMessage);
    error.httpStatus = lastStatus;
    throw error;
  }

  // 三种返回形态统一成 Buffer 列表。
  async function collectImages(payload) {
    const items = [];
    for (const entry of (payload && payload.data) || []) items.push(entry);
    for (const entry of (payload && payload.images) || []) items.push(entry);
    if (items.length === 0 && payload && typeof payload.image === 'string') items.push({ b64_json: payload.image });
    const buffers = [];
    for (const item of items) {
      if (!item) continue;
      if (typeof item === 'string') { buffers.push(await fetchImage(item)); continue; }
      // 有些中转站把 b64_json 写成完整的 data URL（"data:image/png;base64,xxx"），
      // 直接 base64 解码会把前缀当成有效字符，产出一张损坏的图（sharp 报 unsupported format）。
      if (typeof item.b64_json === 'string') { buffers.push(Buffer.from(stripDataUrl(item.b64_json), 'base64')); continue; }
      if (typeof item.image_url === 'string') { buffers.push(await fetchImage(item.image_url)); continue; }
      if (typeof item.url === 'string') { buffers.push(await fetchImage(item.url)); continue; }
      if (item.image && typeof item.image === 'string') { buffers.push(await fetchImage(item.image)); continue; }
    }
    for (const buffer of buffers) {
      if (buffer.length < 1024) throw providerError('EMPTY_RESULT', '模型返回的图像为空。');
    }
    if (buffers.length === 0) throw providerError('EMPTY_RESULT', '模型未返回图像。');
    return buffers;
  }

  // 结果图在另一个域名上（对象存储/图床），它和接口本身是否可达是两件事：
  // 接口那边 200 已经出图，这边连接被重置，整次任务照样作废。
  // 所以「一次失败就放弃」在这里是错的，必须重试。
  async function fetchImage(url) {
    if (url.startsWith('data:')) return Buffer.from(stripDataUrl(url), 'base64');
    const host = safeHost(url);
    let lastDetail = '';
    // 退避：400ms、800ms、1.6s、3.2s、6s、6s、6s（加一点抖动，避免每次撞在同一毫秒）。
    // 线性 500ms×n 的窗口只有七八秒，而这条图床的抖动一次能持续十几秒。
    const backoff = (attempt) => Math.min(6000, downloadRetryDelayMs * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
    for (let attempt = 1; attempt <= downloadAttempts; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(downloadTimeoutMs),
          // 有些图床对默认的 `node` UA 或 `Accept: */*` 直接断连，伪装成普通下载请求成本为零。
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StudioAiImage/1.0)', Accept: 'image/*,*/*' }
        });
      } catch (error) {
        const code = causeCode(error) || (error && error.name) || 'UNKNOWN';
        lastDetail = code;
        process.stderr.write('[provider] 结果图下载失败 ' + attempt + '/' + downloadAttempts + ': host=' + host + ' cause=' + code + '\n');
        if (attempt < downloadAttempts) { await delay(backoff(attempt)); continue; }
        break;
      }
      if (!response.ok) {
        lastDetail = 'HTTP ' + response.status;
        process.stderr.write('[provider] 结果图下载被拒 ' + attempt + '/' + downloadAttempts + ': host=' + host + ' status=' + response.status + '\n');
        // 5xx / 429 是临时故障，值得再试；403 / 404 说明签名已过期或防盗链，
        // 重发一模一样的请求只会得到一模一样的结果。
        if ((response.status >= 500 || response.status === 429) && attempt < downloadAttempts) {
          await delay(backoff(attempt));
          continue;
        }
        throw providerError('RESULT_DOWNLOAD', '结果图像下载失败（HTTP ' + response.status + '，' + host + '）。'
          + (response.status === 403 || response.status === 404 ? '链接可能已过期，请重新生成。' : ''));
      }
      try {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 40 * 1024 * 1024) throw providerError('RESULT_DOWNLOAD', '结果图像过大。');
        if (attempt > 1) process.stderr.write('[provider] 结果图下载成功（第 ' + attempt + ' 次尝试）\n');
        return buffer;
      } catch (error) {
        // 头拿到了、body 读到一半被掐断，是同一个病：继续重试，不要把它当成功。
        if (error && error.code === 'RESULT_DOWNLOAD') throw error;
        const code = causeCode(error) || (error && error.name) || 'BODY_ABORTED';
        lastDetail = code;
        process.stderr.write('[provider] 结果图接收中断 ' + attempt + '/' + downloadAttempts + ': host=' + host + ' cause=' + code + '\n');
        if (attempt < downloadAttempts) { await delay(backoff(attempt)); continue; }
      }
    }
    throw providerError('RESULT_DOWNLOAD', '无法下载结果图像（' + lastDetail + '），已重试 ' + downloadAttempts
      + ' 次。图在 ' + host + ' 上——它是生成好的，只是拉不回来。过一会儿点「重试」只会重新下载这张图，'
      + '不会重新生成、也不会再计费。');
  }

  // 把 API 尺寸对齐到 16 的倍数并限制在像素上限内；宽高比保持不变。
  function planApiSize(canvas) {
    if (!canvas) return null;
    const scale = canvas.width * canvas.height > maxPixels ? Math.sqrt(maxPixels / (canvas.width * canvas.height)) : 1;
    const width = Math.max(16, Math.round(canvas.width * scale / 16) * 16);
    const height = Math.max(16, Math.round(canvas.height * scale / 16) * 16);
    return { width, height };
  }

  // 档位模式：按画布像素量挑 1K/2K/4K。
  // 阈值取 4K≈4096²=16.7M、2K≈2048²=4.2M 的实用分割点，宁可往上取，
  // 因为回来后是缩小（无损观感），取小了就是放大（糊）。
  function planTier(canvas) {
    if (!canvas) return TIER_ORDER[2];
    const pixels = canvas.width * canvas.height;
    if (pixels > 2.4 * 1024 * 1024) return '4K';
    if (pixels > 0.95 * 1024 * 1024) return '2K';
    return '1K';
  }

  // 尺寸字符串（"1536x1520"）→ 像素；档位（"4K"/"auto"）返回 null。
  function parsePixelSize(size) {
    const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size || ''));
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  // 按画布比例缩到「长边 = side」，并对齐到 16 的倍数。
  function fallbackSize(canvas, side = SAFE_FALLBACK_SIDE) {
    if (!canvas) return null;
    const longEdge = Math.max(canvas.width, canvas.height);
    if (longEdge <= side) return null;
    const scale = side / longEdge;
    const width = Math.max(16, Math.round((canvas.width * scale) / 16) * 16);
    const height = Math.max(16, Math.round((canvas.height * scale) / 16) * 16);
    return `${width}x${height}`;
  }

  // gpt-image 这一类模型只认三个标准尺寸，别的值由中转站自己「猜」。
  // 11 月 12 日那次扩图就是栽在这里：要 1536x1520，回来 2834x2220（比例偏 23%）；
  // 要 2608x2560，回来 3132x2010（43%）；要 auto，回来 3094x2034（40%）——
  // 三张都被比例检查判掉，最后落到 1024x1024（唯一比例对得上的），再放大 2.5 倍
  // 贴到 2600 宽画布上。用户看到的就是「内容对不上」。
  // 所以当渠道被证实会改写自定义尺寸时，直接改用「比例最接近画布的标准档」当第一候选：
  // 分辨率低一点（会软），但遮罩几何是对的，模型才有机会真的只补那一块。
  const STANDARD_BUCKETS = ['1536x1024', '1024x1536', '1024x1024'];
  function standardBucket(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    const aspect = canvas.width / canvas.height;
    let best = null;
    let bestSkew = Infinity;
    for (const bucket of STANDARD_BUCKETS) {
      const [w, h] = bucket.split('x').map(Number);
      const skew = Math.abs(Math.log((w / h) / aspect));
      if (skew < bestSkew) { bestSkew = skew; best = bucket; }
    }
    // 偏差超过 6% 的「最接近」其实一点都不接近，宁可不给这个候选。
    return bestSkew <= 0.06 ? best : null;
  }

  // 尺寸降级链：精确 → 交给服务端自适应 → 最近的固定档位 → 最小可用档。
  // 走这条链是因为「中转支持什么尺寸」在写代码时无法确定，与其猜，不如让它自己说不接受。
  //
  // 扩图时两个链的先后要翻过来，原因见下面 options.pixelFirst 的注释；
  // 但两条链都留着——档位被拒的渠道还能靠像素尺寸救，像素尺寸被拒的渠道还能靠档位救。
  function sizeCandidates(canvas, apiSize, preferred, ceiling = 0, options = {}) {
    const list = [];
    const tierFirst = sizeMode === 'tier' && !options.pixelFirst;
    if (tierFirst) {
      list.push(planTier(canvas));
      for (const tier of TIER_ORDER) if (!list.includes(tier)) list.push(tier);
    }
    if (preferred) list.push(preferred);
    // 安全档（长边 = 渠道上限，按画布比例算出来）紧跟在精确尺寸之后：
    // 上游池按尺寸分档时，它才是真正能出图的那一档。
    // 已经探到这个渠道的上限时，直接把上限当作安全档，省掉必败的第一次。
    const fallback = fallbackSize(canvas, ceiling || SAFE_FALLBACK_SIDE);
    if (options.pixelFirst) {
      // 扩图时把安全档排到画布原尺寸前面：2738×2560 这种画布直接要 2738×2560
      // 几乎必然被上游拒，白等十几秒。而按比例算出来的 1536×1440 一次就能出图，
      // 且比例偏差只有 0.3%（实测同一渠道 0.1%）。
      if (fallback) list.push(fallback);
      if (apiSize) list.push(`${apiSize.width}x${apiSize.height}`);
    } else {
      if (apiSize) list.push(`${apiSize.width}x${apiSize.height}`);
      if (fallback) list.push(fallback);
    }
    list.push('auto');
    if (!tierFirst && sizeMode === 'tier') {
      // 兜底才轮到档位：能用说明这个渠道的档位恰好按我们的比例出图（比例检查会验），
      // 不能用就由比例检查判掉，比交付一张拉伸 40% 的图强。
      list.push(planTier(canvas));
      for (const tier of TIER_ORDER) if (!list.includes(tier)) list.push(tier);
    }
    if (canvas) {
      const snapped = snapToAllowedSize(apiSize ? apiSize.width : canvas.width, apiSize ? apiSize.height : canvas.height, allowedSizes);
      if (snapped) list.push(`${snapped.width}x${snapped.height}`);
    } else if (allowedSizes.length) {
      list.push(String(allowedSizes[0]));
    }
    list.push('1024x1024');
    const unique = list.filter((value, index) => list.indexOf(value) === index);
    // 已知上限时把超限的像素尺寸剔掉。档位（4K/2K）和 auto 不参与这个过滤：
    // 它们不是像素尺寸，过滤会把本来能用的候选也扔掉。
    return ceiling ? unique.filter((value) => !exceedsSide(value, ceiling)) : unique;
  }

  // 遮罩：条带处 alpha=0（= 要重绘），其余不透明（= 保留原样）。
  async function buildMaskPng(width, height, strips) {
    const data = Buffer.alloc(width * height * 4, 255);
    for (const s of strips) {
      for (let y = s.top; y < s.bottom; y++) {
        for (let x = s.left; x < s.right; x++) {
          data[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
    return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }

  // 扩图准备：把照片铺满 API 尺寸的画布（预填充），再把新增条带做成遮罩。
  // 预填充仍然保留：它给模型一个连续的底色起点，比纯透明区更容易画出连贯纹理。
  // 同时给出一份「只有原照片」的裁切：bare 形态（只给照片、让它输出更大的构图）
  // 要用它——那种问法完全不碰遮罩，中转站吞掉 mask 时是唯一还能走的路。
  async function prepareExpand(pngBytes, canvas, apiSize, bounds) {
    const sx = apiSize.width / canvas.width;
    const sy = apiSize.height / canvas.height;
    const scaled = {
      left: Math.max(0, Math.round(bounds.left * sx)),
      top: Math.max(0, Math.round(bounds.top * sy)),
      right: Math.min(apiSize.width, Math.round(bounds.right * sx)),
      bottom: Math.min(apiSize.height, Math.round(bounds.bottom * sy))
    };
    scaled.right = Math.max(scaled.left + 1, scaled.right);
    scaled.bottom = Math.max(scaled.top + 1, scaled.bottom);
    const base = apiSize.width === canvas.width && apiSize.height === canvas.height
      ? pngBytes
      : await sharp(pngBytes).resize(apiSize.width, apiSize.height, { fit: 'fill' }).png().toBuffer();
    const filled = await buildExpandInput(base, apiSize, scaled);
    const mask = await buildMaskPng(apiSize.width, apiSize.height, expandStrips(apiSize.width, apiSize.height, scaled));
    const photo = await sharp(base)
      .extract({ left: scaled.left, top: scaled.top, width: scaled.right - scaled.left, height: scaled.bottom - scaled.top })
      .png().toBuffer();
    return { filled, mask, photo };
  }

  // 尺寸字段两种叫法：像素模式写 size="3074x2560"，档位模式写 image_size="4K"。
  // 同一次请求里只发一种，免得服务端把两个都当真。
  //
  // aspect 由调用方传入而不是直接读闭包里的 aspectRatio：档位模式下它是按画布
  // 比例**逐次推导**出来的，配置里那个固定值只是用户的手动覆盖。
  function applySize(target, size, aspect = aspectRatio) {
    if (!size || size === 'auto') return;
    if (sizeMode === 'tier') {
      target.append(tierParam, size);
      if (aspect) target.append('aspect_ratio', aspect);
    } else {
      target.append(sizeParam, size);
    }
  }

  // bare 形态下「模型其实什么都没做」的判定。
  //
  // 这条判据绕了一圈才想明白：bare 传进去的是原照片、要的是「更宽的一张构图」，
  // 如果模型不理会，把原照片原样交回，它的比例和画布对不上，而内容又和照片一模一样。
  // 直接和有留白的底稿比没有意义（照片的右半边本来就有像素），所以换个比法：
  // 把回图缩到原照片尺寸再逐像素比。真扩过图的回图是更宽的构图，缩回去必然整体错位；
  // 原样交回的图缩回去几乎重合。
  async function bareEcho(candidate, photo) {
    try {
      const meta = await sharp(photo).metadata();
      if (!meta.width || !meta.height) return false;
      const a = await sharp(candidate).resize(meta.width, meta.height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      const b = await sharp(photo).removeAlpha().raw().toBuffer();
      if (a.length !== b.length || !a.length) return false;
      let sum = 0;
      let n = 0;
      // 每 7 个字节取一个：约等于均匀撒点，又避开了「每次只落在一个通道上」的偏采样。
      for (let i = 0; i < a.length; i += 7) { sum += Math.abs(a[i] - b[i]); n++; }
      return n > 0 && sum / n < 3;
    } catch (_) {
      return false;
    }
  }

  async function sendEdit({ images, mask, prompt, size, count, aspect }) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', String(prompt || DEFAULT_FILL_PROMPT));
    // Gemini 那一类只出一张，多传 n 反而可能被判非法参数；只有真要多个候选时才发。
    if (count > 1 || sizeMode !== 'tier') form.append('n', String(count));
    applySize(form, size, aspect);
    let uploadBytes = 0;
    let uploadDims = '';
    for (let index = 0; index < images.length; index++) {
      const shrunk = await shrinkForUpload(images[index]);
      uploadBytes += shrunk.bytes.length;
      // 把「发出去的图到底多大」也记下来。以前只有请求尺寸，于是「要 2608x2560、
      // 实际传了 1536x1504」这种错配在日志里完全看不出来——而它正是模型重画的源头。
      if (index === 0) {
        try { const meta = await sharp(shrunk.bytes).metadata(); uploadDims = meta.width + 'x' + meta.height; } catch (_) { /* 读不出就不记 */ }
      }
      const name = shrunk.type === 'image/jpeg' ? '.jpg' : '.png';
      form.append(imageField, new Blob([shrunk.bytes], { type: shrunk.type }), index === 0 ? 'image' + name : 'image-' + index + name);
    }
    if (mask) form.append(maskField, new Blob([mask], { type: 'image/png' }), 'mask.png');
    // 上传体积是这类失败的第一嫌疑：10MB 的 PNG 在很多中转站上会被直接断连，
    // 而且断连报错和「网络不通」长得一模一样。把数字打出来，才能一眼分辨。
    process.stderr.write('[upload] edits size=' + (size || 'auto')
      + ' image=' + (uploadBytes / 1024 / 1024).toFixed(1) + 'MB'
      + (uploadDims ? '(' + uploadDims + ')' : '')
      + ' mask=' + (mask ? Math.round(mask.length / 1024) + 'KB' : '-') + '\n');
    return callApi('/images/edits', { method: 'POST', body: form });
  }

  async function sendGeneration({ prompt, size, count, aspect }) {
    const body = { model, prompt: String(prompt) };
    if (count > 1 || sizeMode !== 'tier') body.n = count;
    if (size && size !== 'auto') {
      if (sizeMode === 'tier') {
        body[tierParam] = size;
        if (aspect) body.aspect_ratio = aspect;
      } else {
        body[sizeParam] = size;
      }
    }
    return callApi('/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async function submit(job) {
    const count = job.n || 1;
    const isGenerate = job.operation === 'generate' && !job.image;
    const { pngBytes, maskBytes } = job.image ? await decodeCapture(job.image, job.mask) : { pngBytes: null, maskBytes: undefined };
    const canvas = pngBytes ? await sharp(pngBytes).metadata().then((m) => ({ width: m.width, height: m.height })) : null;
    const apiSize = planApiSize(canvas);
    let bounds = null;
    // 扩图需要知道「原照片在画布中的位置」。优先用 PS 传来的图层范围，
    // 没有就从透明区反推——两条都不通时放弃 mask，退回整图指令编辑。
    if (job.operation === 'expand') {
      // 优先用 Photoshop 传来的图层范围（几何真值），拿不到或不合理时才退回
      // 「分析 PNG 的 alpha 反推」——后者对半透明边缘很敏感，只能当备胎。
      bounds = saneBounds(job.canvasBounds, canvas);
      if (!bounds) {
        const info = await inspectImage(pngBytes);
        bounds = saneBounds(info.opaqueBounds, canvas);
      }
      if (!bounds) throw providerError('NO_EXPAND_AREA', '画布上看不出清晰的「原图 + 透明扩展区」。请先把画布拉大、让原图贴住其中一侧，或在扩图方向里填好比例后重试。');
    }

    // 文生图没有画布，尺寸只能来自请求参数（面板给的是 "1024*1024" 这种写法）。
    const requestedSize = isGenerate && typeof job.size === 'string' ? job.size.replace('*', 'x') : null;
    const ceilingKey = root + '|' + model;
    const ceiling = knownCeilings.get(ceilingKey) || 0;
    if (ceiling) process.stderr.write('[provider] 已知渠道上限 ' + ceiling + '，本次直接按安全档规划\n');

    // ── 档位模式的宽高比：按画布比例自动推导 ──────────────────────────────
    // Gemini 这类渠道只接受固定的几档宽高比（1:1 / 3:2 / 16:9 …），画布比例再怪
    // 也只能就近取一档。以前这个值只能由用户在渠道设置里手填 aspect_ratio，
    // 而没人会为每张画布改一次配置：空着就按渠道默认比例出图（实测 38% 偏差，
    // 模型整张重画），填错更糟。所以改成能推导就推导，手填的值只在显式配置时生效。
    const autoAspect = sizeMode === 'tier' && !aspectRatio ? aspectForCanvas(canvas) : null;
    const effectiveAspect = aspectRatio || (autoAspect ? autoAspect.ratio : '');
    // 档位能不能用，取决于「画布比例」和「最接近的标准比例」差多少。
    // 2600×2560（1.016）对 1:1 只差 1.6%，把画布拉伸 1.6% 去做底稿，肉眼看不出来；
    // 但 2.17 的画布对 21:9（2.33）差 7.7%，拉伸就很明显了——那种画布宁可走
    // 像素尺寸：分辨率低，至少几何是真的。
    const aspectStretch = autoAspect ? autoAspect.skew : 0;
    const tierUsable = sizeMode === 'tier' && Boolean(effectiveAspect) && aspectStretch <= MAX_ASPECT_SKEW;
    if (autoAspect) {
      process.stderr.write('[provider] 画布 ' + (canvas ? canvas.width + 'x' + canvas.height : '无')
        + ' → 宽高比 ' + effectiveAspect + '（偏差 ' + (aspectStretch * 100).toFixed(1) + '%）'
        + (tierUsable ? '' : '，偏差偏大，这一单改用像素尺寸') + '\n');
    }
    // 扩图对宽高比零容忍：渠道的尺寸档位（4K/2K/1K）宽高比往往是**固定**的，
    // 实测 comfly 的 4K 档一律回 3:2——画布 2738×2560（1.07）拿到 3018×2084（1.45），
    // 偏差 38%。模型于是不是"补右边"，而是在一张比例完全不同的画布上重新构图，
    // drift 直接 50 灰阶。像素尺寸能精确控制比例（同一渠道实测偏差 0.1%）。
    // 所以默认让像素尺寸优先；但档位模式只要宽高比可控（能推导出够接近的标准比例），
    // 就该用档位——4K 的 4096 边长对 2600 画布是**缩小**，像素尺寸那条路只会拿到 1024。
    const expandMode = job.operation === 'expand' && !!bounds && !tierUsable;
    const candidates = sizeCandidates(canvas, apiSize, requestedSize, ceiling, { pixelFirst: expandMode });
    // 已经知道这个渠道会改写尺寸：让标准档排第一，别再花两分钟去证明同一件事。
    const bucket = expandMode ? standardBucket(canvas) : null;
    if (bucket && sizeRewrites.has(ceilingKey)) {
      const at = candidates.indexOf(bucket);
      if (at >= 0) candidates.splice(at, 1);
      candidates.unshift(bucket);
      process.stderr.write('[provider] 这条渠道会改写自定义尺寸，这次直接用标准档 ' + bucket
        + '（与画布比例最接近），分辨率会低一些但几何是对的\n');
    }
    let lastSizeError = null;
    let downshifted = false;
    let downshiftFrom = '';
    // 底稿和遮罩跟「本次请求的尺寸」有关，按尺寸缓存一份即可（见下面的 preparedFor）。
    let preparedExpand = null;
    let preparedFor = '';
    // 扩图「画了但不理想」时的说明，最后和降档提示一起回给面板。
    // 这类结果不再当失败吞掉，所以必须让用户知道该看哪里、下次怎么改。
    let expandNotice = '';
    // 判定「渠道会改写尺寸」的当场补救：第一个候选被比例检查判掉时，把标准档插到
    // 队首继续，而不是按原顺序把 auto / 档位一个个试完（那要多花两分钟，还都是废的）。
    // 只补一次：标准档自己也被改写的话，说明这条路彻底不通，让它正常走完报错。
    let rebucketed = false;
    for (let ci = 0; ci < candidates.length; ci++) {
      const size = candidates[ci];
      try {
        let payload;
        let images = null;
        if (isGenerate) {
          payload = await sendGeneration({ prompt: job.prompt, size, count, aspect: effectiveAspect });
        } else if (job.operation === 'expand' && bounds) {
          // 底稿必须按「这次真正要发的尺寸」来做，不能固定用画布尺寸。
          // 以前 preparedExpand 只算一次（apiSize = 1536 长边），之后无论向渠道要
          // 2608x2560 还是 1024x1024，传上去的都是同一张 1536x1504——尺寸和图片对不上，
          // 中转站要么替你缩、要么自己按别的比例重排，遮罩的几何跟着一起错。
          // 模型拿到一张和自己被要求输出的尺寸不符的底稿，最省事的做法就是整张重画，
          // 这也是 drift 常年 36~57 灰阶的一部分原因。
          //
          // 档位模式又不一样：请求里没有像素尺寸，只有 image_size + aspect_ratio。
          // 这时候底稿的比例必须等于 aspect_ratio（而不是画布比例），否则模型看到的
          // 留白占比和最终合成的几何差一截，接缝会错开几十像素。
          const wantedPrep = parsePixelSize(size);
          const prep = wantedPrep && Math.min(wantedPrep.width, wantedPrep.height) >= 256
            ? wantedPrep
            : (tierUsable ? aspectBox(effectiveAspect) : apiSize);
          const prepKey = prep.width + 'x' + prep.height;
          if (!preparedExpand || preparedFor !== prepKey) {
            preparedExpand = await prepareExpand(pngBytes, canvas, prep, bounds);
            preparedFor = prepKey;
          }
          const stripRects = expandStrips(canvas.width, canvas.height, bounds);
          let reason = 'empty';
          // 每一次尝试的结果都留一份，最后按「有多不像样」挑一个交差。
          // 以前是「最后一次不合格就报错」，等于把前面几次可能更好的结果连同
          // 一次真实的生成一起扔掉——用户花了钱、等了两分钟，最后画布上什么都没有。
          let best = null;
          // 安全拦截要单独记一笔：它既不是「画得不对」，也不是「渠道挂了」，
          // 直接抛出去会让一次本可以成功的扩图白等一分钟（底稿都传完了）。
          let policyBlocked = null;
          // 每次提交一个不同的编号，让提示词文本不与历史请求重复。
          // 渠道会按文本缓存安全判定，见过一次 451 的文本以后永远 451。
          const stamp = Date.now().toString(36).slice(-6);
          for (let attempt = 1; attempt <= EXPAND_ATTEMPTS; attempt++) {
            const shape = EXPAND_SHAPES[Math.min(attempt - 1, EXPAND_SHAPES.length - 1)];
            const bare = shape === 'bare';
            try {
              payload = await sendEdit({
                images: [bare ? preparedExpand.photo : preparedExpand.filled],
                mask: shape === 'masked' ? preparedExpand.mask : null,
                prompt: buildExpandPrompt(job.prompt, { bounds, canvas, attempt, shape, reason, stamp: stamp + attempt }),
                size,
                count,
                aspect: effectiveAspect
              });
            } catch (error) {
              // 内容安全拦截是中转站给出的确定性判定（HTTP 451 / "content safety policy"）。
              // 它对「这一种问法」是确定的，对另一种问法未必——三种形态的措辞差异很大。
              // 所以这里不能把它当成致命错误，而是当成一次失败的尝试，继续换形态。
              if (!isPolicyBlock(error)) throw error;
              policyBlocked = error;
              process.stderr.write('[expand] 第 ' + attempt + ' 次（' + shape + '）被渠道安全策略拦下，换一种请求形态重试\n');
              continue;
            }
            const shots = await collectImages(payload);
            images = shots;
            // 宽高比检查要放在最前面，早于任何内容判定。
            //
            // 合成层会把模型回图直接 resize 到画布尺寸，回图比例差多少，延伸区就被
            // 拉伸多少。4K 档固定回 3:2 时偏差 38%，接缝要错位上千像素——这种图内容
            // 画得再好也不可能接上，判它"画得不对"是误诊。真正的问题是这一档根本没
            // 按我们的画布出图，应该换下一个尺寸候选。
            //
            // 比对的目标要分清：档位模式下请求的是 aspect_ratio，模型只保证「输出这个
            // 比例」，它跟画布比例本来就差那 1~2%（差额由底稿的轻微拉伸吸收）。所以
            // 那里要跟 aspect_ratio 比，跟画布比会把自己的正常出图判成错的。
            //
            // bare 形态例外：它的输入是原照片（比例本来就不同于画布），模型若原样
            // 交回，比例偏差恰恰是「根本没扩图」的证据，该判废而不是换尺寸——
            // 换哪个尺寸都没用，输入永远是那张照片。
            const targetRatio = tierUsable ? (ratioValue(effectiveAspect) || canvas.width / canvas.height) : canvas.width / canvas.height;
            let skew = 0;
            try {
              const shotMeta = await sharp(shots[0]).metadata();
              if (shotMeta.width && shotMeta.height) {
                skew = Math.abs(Math.log((shotMeta.width / shotMeta.height) / targetRatio));
                if (skew > MAX_ASPECT_SKEW && !bare) {
                  process.stderr.write('[expand] ' + size + ' 档返回 ' + shotMeta.width + 'x' + shotMeta.height
                    + '，比例偏离目标 ' + (skew * 100).toFixed(0) + '%，不能用于扩图，换下一代尺寸\n');
                  throw Object.assign(
                    new Error('当前渠道这个尺寸档位的宽高比是固定的，返回的图跟需要的比例差了 '
                      + (skew * 100).toFixed(0) + '%，用来扩图会被拉伸变形。换一个支持自定义像素尺寸的渠道，'
                      + '或在渠道设置里把尺寸模式改成「像素」。'),
                    { sizeRejected: true, code: 'SIZE_ASPECT' }
                  );
                }
              }
            } catch (error) {
              // 抛出去的是上面那条「这一档不能用」，要让它落到外层换候选；
              // 读不出尺寸（metadata 失败）就当作没问题，继续走内容判定。
              if (error && error.sizeRejected) throw error;
            }
            // 请求成功不代表画了东西：模型把模糊底稿原样交回来时，一切"看起来"都正常，
            // 只有把结果和底稿逐像素比一遍才看得出来。
            // bare 形态的输入是原照片，模型必然重画整幅——照片区漂移在那种问法下
            // 不构成「接不上」的证据，所以关掉这条判据，只看延伸区本身。
            const verdict = await extensionFidelity(shots[0], preparedExpand.filled, stripRects, canvas, bounds, { regenerated: bare });
            if (verdict.checked) {
              process.stderr.write('[expand] 第 ' + attempt + ' 次（' + shape + '）扩展区 diff=' + verdict.diff.toFixed(1)
                + ' near=' + verdict.nearShare.toFixed(2) + ' white=' + verdict.whiteShare.toFixed(2)
                + ' detail=' + verdict.extDetail.toFixed(2) + '/' + verdict.photoDetail.toFixed(2)
                + ' drift=' + verdict.photoDrift.toFixed(1)
                + ' 评分=' + verdict.severity
                + (verdict.stale ? '（与底稿一致，模型没重绘）' : verdict.blank ? '（画成一片白）'
                  : verdict.alien ? '（原照片被重画了，延伸区是它自己重新构图）'
                    : verdict.flat ? '（没有细节，糊成一片）' : '') + '\n');
            }
            // 没能判定（比如渠道回了一张尺寸异常的图）就按成功处理，不要把偶然的读取失败
            // 变成一次白等十分钟的重试。
            let severity = verdict.checked ? verdict.severity : 0;
            // bare 形态的隐患：模型可能无视「输出更大的构图」，把照片原样交回来。
            // 比例没变成画布比例，或者像素跟原照片几乎重合，都说明它一个像素都没扩。
            if (bare && severity < 100) {
              if (skew > 0.05) {
                severity = 100;
                process.stderr.write('[expand] bare 形态返回的比例还是照片本身（偏 ' + (skew * 100).toFixed(0) + '%），没扩图\n');
              } else if (await bareEcho(shots[0], preparedExpand.photo)) {
                severity = 100;
                process.stderr.write('[expand] bare 形态把原照片原样交回来了，一个像素都没扩\n');
              }
            }
            // bare 形态给一个底分：它没有遮罩，模型必然重画整幅，所以「延伸区有没有
            // 贴着原照片长出来」根本无从判断。只要它画出了东西就留着当兜底，
            // 但永远排在「带遮罩、验证通过」的结果之后——那才是真正接得上的那种。
            if (bare && severity < 100) severity = Math.max(severity, 10);
            const flag = verdict.alien ? 'alien' : verdict.flat ? 'flat' : 'ok';
            if (!best || severity < best.severity) best = { image: shots[0], severity, shape, flag };
            if (severity <= 0) break;
            // 重试文案要对着「上一版错在哪」说。三种错法要三种话术：
            // 原照片被重画 → 只延伸背景、别加东西；糊成一片 → 画出层次但要保持同样的虚化。
            reason = verdict.alien ? 'alien' : verdict.stale || verdict.blank ? 'empty' : 'flat';
            if (attempt === EXPAND_ATTEMPTS) break;
            process.stderr.write('[expand] 扩展区不合格（' + reason + '），换一种请求形态重试\n');
          }
          // 三种形态都被安全策略拦下：没有任何结果可用。这条必须单独报，
          // 一是 `best` 是空的，落到下面 `best.image` 会变成一句 TypeError；
          // 二是它跟「模型画得不对」完全不同，用户需要的是「怎么改措辞」而不是「把比例调小」。
          if (!best && policyBlocked) {
            throw providerError('EXPAND_BLOCKED',
              '这次请求被渠道的内容安全策略拦下了（三种请求方式都被拦），跟画面画得好不好无关。'
              + '渠道会按提示词文本记住这个判定，相同的描述再发还是会被拦：在「画面描述」里换个说法，'
              + '或把画布尺寸改一点再试；也可以换一个模型。');
          }
          // 一次都没画出内容（模型把底稿原样交回，或糊成一片纯白）才是真的没有结果可给，
          // 这时候报错是诚实的；只要画出了东西，就交给用户自己判断，并在面板上说明毛病。
          if (!best || best.severity >= 100) {
            throw providerError('EXPAND_FLAT',
              '这次生成没有在扩展区画内容：模型把留白的底稿原样交回来了（三种请求方式都试过）。可以在「画面描述」里写清右边只需要延续什么（例如「白墙和木地板，暖光」），或把扩图比例调小一点再试。');
          }
          if (best && best.severity > 0) {
            // 提示要按「它到底错在哪」写，不能按「它来自哪种问法」写：
            // 带遮罩的那次也可能整张重画，只写「偏糊」会让用户往错的方向调。
            const redrawn = best.shape === 'bare' || best.flag === 'alien';
            expandNotice = redrawn
              ? '这次模型把整张画面按自己的理解重新画了一遍，延伸区不是贴着原照片长出来的：颜色和光线已经对齐过，但结构可能还是接不太上。「画面描述」里只写要延续的材质和光线（例如「白墙、木地板、暖光」），别列台灯、架子这类物体——列了它就会真的画一个新的出来；把扩图比例调小一点也会好很多。'
              : '这次延伸区画得偏糊，没有画出足够的层次，已经按原照片的清晰度和色温压过一遍。把扩图比例调小一点会更自然。';
            process.stderr.write('[expand] 三次里最好的一次评分 ' + best.severity + '（' + best.shape + '/' + best.flag + '），照常出图并提示用户\n');
          }
          images = [best.image];
        } else if (job.operation === 'editMasked' && maskBytes) {
          const apiMask = await sharp(maskBytes)
            .resize(apiSize.width, apiSize.height, { fit: 'fill' })
            .removeAlpha()
            .greyscale()
            .threshold(128)
            .png()
            .toBuffer();
          // 本地选区掩码是「白色=要编辑」，OpenAI 是「透明=要编辑」，两者正好相反。
          const inverted = await sharp(apiMask).negate().ensureAlpha().png().toBuffer();
          const base = canvas.width === apiSize.width && canvas.height === apiSize.height
            ? pngBytes
            : await sharp(pngBytes).resize(apiSize.width, apiSize.height, { fit: 'fill' }).png().toBuffer();
          payload = await sendEdit({ images: [base], mask: inverted, prompt: job.prompt, size, count });
        } else {
          const base = canvas && (canvas.width !== apiSize.width || canvas.height !== apiSize.height)
            ? await sharp(pngBytes).resize(apiSize.width, apiSize.height, { fit: 'fill' }).png().toBuffer()
            : pngBytes;
          payload = await sendEdit({ images: [base], prompt: job.prompt, size, count });
        }

        const collected = images || await collectImages(payload);
        const results = [];
        for (const image of collected) {
          if (job.operation === 'expand' && bounds && canvas) {
            const strips = expandStrips(canvas.width, canvas.height, bounds);
            // 这行是排查「扩图区合并后一片透明」的关键证据：canvas 是画布尺寸，bounds 是
            // 原照片范围，strips 是要生成的新增块。strips 为空或只有几像素宽 → 问题在服务端
            // 的范围判断；strips 正常却仍看不到 → 问题在 CEP 侧的裁切落位。
            process.stderr.write('[expand] canvas=' + canvas.width + 'x' + canvas.height
              + ' src=' + (job.canvasBounds ? 'ps' : 'alpha')
              + ' bounds=' + JSON.stringify(bounds)
              + ' strips=' + JSON.stringify(strips) + '\n');
            // 模型实际回了多大一张图，以前从没记过。它和请求尺寸不一致时，
            // composeExpand 会按 fill 硬拉到画布比例——宽高比差得多就是一次变形，
            // 而接缝处的错位往下追就只能靠这行日志了。
            try {
              const meta = await sharp(image).metadata();
              if (meta.width && meta.height) {
                const skew = Math.abs(Math.log((meta.width / meta.height) / (canvas.width / canvas.height)));
                process.stderr.write('[expand] 模型返回 ' + meta.width + 'x' + meta.height
                  + '，画布 ' + canvas.width + 'x' + canvas.height
                  + '，比例偏差 ' + (skew * 100).toFixed(1) + '%'
                  + (skew > 0.05 ? '（超过 5%，会被拉伸变形）' : '') + '\n');
              }
            } catch (_) { /* 读不出尺寸不影响出图 */ }
            // 条带为空等于「整幅画面都是原图」，合成出来会是一张全透明 PNG。
            // 这种图交给 CEP 是纯灾难：裁切、合并全都"成功"，扩图区却是空的。
            // 宁可报错让用户看到原因，也不要产出一张看起来正常、实际什么都没有的结果。
            if (!strips.length) throw providerError('NO_EXPAND_AREA', '没有可生成的扩展区域：原图已经铺满画布。请先把画布拉大再试。');
            // base/bounds 一并交给合成层：贴回画布后要在接缝上做羽化与色差对齐，
            // 否则生成块就是「一刀切」地压在原图上，色温和锐度差一截，一眼看出是拼的。
            results.push(await composeExpand(image, {
              window: { left: 0, top: 0, right: canvas.width, bottom: canvas.height },
              strips,
              frame: canvas,
              bounds,
              base: pngBytes
            }));
          } else if (canvas) {
            // 结果尺寸常被服务端改掉（固定档位、或 16 的倍数对齐），
            // 一律缩回画布尺寸，CEP 侧才敢按画布坐标裁切。
            const meta = await sharp(image).metadata();
            results.push(meta.width === canvas.width && meta.height === canvas.height
              ? await sharp(image).png().toBuffer()
              : await sharp(image).resize(canvas.width, canvas.height, { fit: 'fill' }).png().toBuffer());
          } else {
            results.push(await sharp(image).png().toBuffer());
          }
        }
        const taskId = `sync-${randomUUID()}`;
        const urls = results.map((buffer, index) => {
          const key = `${taskId}:${index}`;
          pending.set(key, buffer);
          return key;
        });
        // 降档才出图 = 探到了这条渠道的真实上限，记下来给后续任务用。
        if (downshifted && !ceiling) {
          knownCeilings.set(ceilingKey, SAFE_FALLBACK_SIDE);
          process.stderr.write('[provider] 记录渠道上限 ' + SAFE_FALLBACK_SIDE + '（' + model + '）\n');
        }
        // 主动选小尺寸（不是被上游拒绝后降档）也要说一声。扩图现在固定走像素尺寸
        // 换比例准确，画布 2738×2560 时只能按 1536 长边生成再放大 1.8 倍——
        // 这是有意的取舍（几何对 > 分辨率高），但用户会看到「怎么有点糊」，
        // 得让他知道这是预期行为，不是又出问题了。
        let smallSizeNote = '';
        if (!downshiftFrom && /^\d+x\d+$/.test(size) && canvas) {
          const usedLong = Math.max(...size.split('x').map(Number));
          const canvasLong = Math.max(canvas.width, canvas.height);
          if (usedLong < canvasLong * 0.95) {
            const factor = (canvasLong / usedLong).toFixed(1);
            smallSizeNote = `本次按 ${size} 生成，再放大 ${factor} 倍贴到画布：这个渠道只认 1024 这一档标准尺寸，`
              + '比例是对的（接缝不会错位），但延伸区的细节会比原图软。'
              + '想更清楚需要换一个能接受大尺寸的渠道。';
          }
        }
        return { taskId, resultUrls: urls, size, notice: [downshiftFrom ? `当前渠道在 ${downshiftFrom} 这种大尺寸下没有可用上游，已按 ${size} 生成再放大到画布，细节会比原图软一些。` : '', smallSizeNote, expandNotice].filter(Boolean).join(' ') };
      } catch (error) {
        if (error && error.sizeRejected) {
          // 比例被改写 = 这个渠道不认自定义尺寸。记住这件事，并把标准档提前到
          // 当前候选之后：同一张画布没必要再按原顺序把 auto、档位各撞一次。
          if (error.code === 'SIZE_ASPECT') {
            sizeRewrites.add(ceilingKey);
            if (bucket && !rebucketed && candidates.indexOf(bucket) !== ci) {
              const at = candidates.indexOf(bucket);
              if (at >= 0) candidates.splice(at, 1);
              candidates.splice(ci + 1, 0, bucket);
              rebucketed = true;
              process.stderr.write('[provider] 改用标准档 ' + bucket + ' 重试（它和画布比例只差 '
                + (Math.abs(Math.log((Number(bucket.split('x')[0]) / Number(bucket.split('x')[1])) / (canvas.width / canvas.height))) * 100).toFixed(1) + '%）\n');
            }
          }
          lastSizeError = error;
          continue;
        }
        // 两种表现、同一个原因：超过渠道能力档的尺寸，要么被路由到空池（503 upstream），
        // 要么被网关在上传途中直接掐断（ECONNRESET，实测 2048 档必断、1536 档 42 秒出图）。
        // 只认 503 会让「连接被重置」这种表现一路漏到用户面前——红字还写着"请检查网络"，
        // 而网络其实是好的。所以 reset 也要降档。
        const sizeSuspect = error && (error.code === 'PROVIDER_UPSTREAM' || (error.code === 'PROVIDER_NETWORK' && error.reset));
        if (sizeSuspect && !downshifted && exceedsSide(size, SAFE_FALLBACK_SIDE)) {
          downshifted = true;
          downshiftFrom = size;
          process.stderr.write('[provider] 尺寸 ' + size + ' 被上游拒绝（' + error.code + (error.causeCode ? ' ' + error.causeCode : '') + '），降到 ' + SAFE_FALLBACK_SIDE + ' 长边重试\n');
          continue;
        }
        // 上游挂掉时补上「这次要了多大一张图」。用户看到的原始红字只有一句
        // "10k pool upstream unavailable"，没法判断是自己图太大还是站方的问题；
        // 带上尺寸和像素量，才有可能自己做减法（换小画布 / 换模型）。
        if (error && error.code === 'PROVIDER_UPSTREAM') {
          const rawDetail = error.providerMessage || '';
          if (rawDetail) process.stderr.write('[provider] 上游拒绝: ' + rawDetail + '\n');
          // 池子类失败和「上游真的挂了」要说不同的话：前者是随机的容量波动，同一个请求
          // 隔一会儿就能过，而且插件已经自动试过几轮；后者才是站方持续故障。混成一句
          // 「等十几秒点重试」，用户会以为自动重试根本没发生，也容易把原因猜成
          // 「这个尺寸不支持」——实测同一尺寸连发 4 次全过，这个猜测是错的。
          const pooled = isPoolError(error.httpStatus, rawDetail);
          const detail = trimProviderDetail(rawDetail);
          error.message = '图像服务上游暂时不可用。' + sizeNote(size)
            + (pooled
              ? '这是中转站按「模型 + 尺寸」去上游池挑节点时的容量波动：不是你的配置问题，也不是这个尺寸不支持，同一个请求隔一会儿再发通常就能过。已经自动重试 '
                + poolRetries + ' 次仍没抢到节点，等半分钟再点「重试」，或者换一个模型。'
              : '这是中转站侧的临时故障，不是你的配置问题：等十几秒点「重试」通常就能过；一直这样就换个模型或渠道。')
            + (detail ? '（接口原文：' + detail + '）' : '');
        }
        // 「连接被重置」在降档后仍然发生，就不再是尺寸问题了：说明对面整体拒收，
        // 这时还让用户去查网线只会浪费时间，得说清楚是渠道/网关侧的问题。
        if (error && error.code === 'PROVIDER_NETWORK' && error.reset) {
          const smallSize = !exceedsSide(size, SAFE_FALLBACK_SIDE);
          error.message = '图像接口在传输中断开连接（' + (error.causeCode || 'ECONNRESET') + '）。' + sizeNote(size)
            + (smallSize
              ? (downshifted
                ? '已自动降档到这么小的尺寸仍被断开，说明该渠道的图像服务此刻整体不可用，不是本地网络问题：等几分钟再试，或换一个模型/渠道。'
                : '这个尺寸并不大却仍被断开，说明该渠道的图像服务此刻整体不可用（或触发了频控），不是本地网络问题：等几分钟再试，或换一个模型/渠道。')
              : '通常是大尺寸请求被中转站网关丢弃：等十几秒点「重试」，或把扩图比例调小、换更小的画布。');
        }
        throw error;
      }
    }
    throw lastSizeError || providerError('SIZE_REJECTED', '接口不接受任何可用尺寸，请在模型名后确认支持的输出尺寸。');
  }

  function poll(taskId) {
    const urls = [];
    for (let index = 0; index < 8; index++) {
      const key = `${taskId}:${index}`;
      if (!pending.has(key)) break;
      urls.push(key);
    }
    if (urls.length) return { status: 'SUCCEEDED', resultUrls: urls };
    return { status: 'FAILED', errorCode: 'EMPTY_RESULT' };
  }

  function download(url) {
    const key = String(url);
    const buffer = pending.get(key);
    if (!buffer) throw providerError('RESULT_UNAVAILABLE', '结果已失效。');
    // 取走即删：jobManager 每个结果只下载一次，留着只是白占内存。
    pending.delete(key);
    return buffer;
  }

  // 探针用：把 /models 拉回来，顺便验证鉴权和地址是否可达。
  async function listModels() {
    const payload = await callApi('/models', { method: 'GET' }, 20000);
    const data = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return data.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean);
  }

  return { submit, poll, download, listModels, model, root };
}

module.exports = { createOpenAiCompatProvider, normalizeBaseUrl, DEFAULT_ALLOWED_SIZES, aspectForCanvas, aspectBox, ratioValue };
