'use strict';

const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { decodeCapture, prepareExpansion, inspectImage, buildExpandInput } = require('../image-inspection');
const { problem } = require('../contract');
const { createTtlMap } = require('../ttl-map');
const { composeExpand, encodeApiImage, expandStrips, saneBounds } = require('../expand-compose');
const { buildExpandPrompt } = require('../expand-prompt');

// 指令式图像编辑模型走 multimodal 接口：一张图 + 一句指令 + 指定输出尺寸。
// 默认 qwen-image-3.0-pro：实测扩图衔接明显好于 wan2.7-image-pro（后者会把预填充的
// 模糊色带当成景深保留，接缝处留下一条偏亮竖带），且单价更低（1K ¥0.25 vs ¥0.50）。
// 可用环境变量换成 wan2.7-image-pro、wan2.7-image、qwen-image-3.0 等。
const MULTI_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
// 参数化扩图：四边各加多少像素由我们自己算，模型不参与决定几何。
// 这是目前唯一能同时保证「输出尺寸精确等于画布」和「原图像素不经过二次生成」的路径，
// 指令式模型（qwen-image 系）做不到——它拿到一张填好的画布就会整幅重画。
const OUTPAINT_PATH = '/api/v1/services/aigc/image2image/out-painting';
const OUTPAINT_MODEL = 'image-out-painting';
// 官方限制：输入/输出单边 512~4096。超出这个区间宁可退回指令式，也不降采样——
// offsets 是像素真值，降采样之后它就不再对应画布上的位置了。
const OUTPAINT_MIN_SIDE = 512;
const OUTPAINT_MAX_SIDE = 4096;
const DEFAULT_EDIT_MODEL = 'qwen-image-3.0-pro';
const EDIT_MODEL = String(process.env.STUDIO_EDIT_MODEL || DEFAULT_EDIT_MODEL).trim() || DEFAULT_EDIT_MODEL;
// 该接口对输出总像素有上限（约 2048×2048），更大的画布要等比降采样，出图后放大回原尺寸。
const MULTI_MAX_PIXELS = 2048 * 2048;
// 窗口化扩图时，窗口在接缝另一侧留给原照片的上下文宽度（像素）。
// 材质、光线、透视全靠这一截，太小模型会瞎接，太大又把画布撑回超限。
const EXPAND_WINDOW_MARGIN = 480;

function providerError(code, message) {
  return problem(code, message);
}

// 规划「只送多大一块给模型」。
// 返回 null 表示不走窗口方案（没有新增区、或窗口省不下多少面积）。
function planExpandWindow(info, b) {
  const frameW = info.width;
  const frameH = info.height;
  const strips = expandStrips(frameW, frameH, b);
  if (!strips.length) return null;

  const union = {
    left: Math.min(...strips.map((s) => s.left)),
    top: Math.min(...strips.map((s) => s.top)),
    right: Math.max(...strips.map((s) => s.right)),
    bottom: Math.max(...strips.map((s) => s.bottom))
  };
  // 窗口要装下整条新增区，还要带上原照片的一截作为上下文（材质、光线、透视都靠它）。
  const tryPlan = (margin) => {
    const window = {
      left: Math.max(0, union.left - margin),
      top: Math.max(0, union.top - margin),
      right: Math.min(frameW, union.right + margin),
      bottom: Math.min(frameH, union.bottom + margin)
    };
    // 宽度按 16 对齐，模型就不用再量化一次（量化会多一次重采样）。
    // 对齐是「向内收」，收掉的那几像素可能刚好切到条带边缘；一旦切到就不对齐，
    // 宁可让模型自己量化，也不能让窗口少算一条边——合成的图会缺一块。
    const aligned = { left: window.left, top: window.top, right: window.right, bottom: window.bottom };
    const alignedW = Math.floor((window.right - window.left) / 16) * 16;
    if (alignedW >= 16) aligned.right = aligned.left + alignedW;
    const alignedH = Math.floor((window.bottom - window.top) / 16) * 16;
    if (alignedH >= 16) aligned.bottom = aligned.top + alignedH;
    const covers = strips.every((s) => s.left >= aligned.left && s.top >= aligned.top && s.right <= aligned.right && s.bottom <= aligned.bottom);
    return covers ? aligned : window;
  };
  // 从大往小试：先要足够上下文；装不下就缩，缩到没有余量还装不下就放弃窗口方案。
  for (const margin of [EXPAND_WINDOW_MARGIN, 320, 160, 0]) {
    const window = tryPlan(margin);
    const w = window.right - window.left;
    const h = window.bottom - window.top;
    if (w * h > MULTI_MAX_PIXELS) continue;
    // 窗口几乎等于整张画布时，窗口方案没有任何收益，交回原来的整画布路径。
    if (w >= frameW - 16 && h >= frameH - 16) return null;
    // 必须完整覆盖所有条带，否则合成的图会缺一块。
    if (!strips.every((s) => s.left >= window.left && s.top >= window.top && s.right <= window.right && s.bottom <= window.bottom)) return null;
    return { window, strips };
  }
  return null;
}

// expandStrips / composeExpand / encodeApiImage 已抽到 ../expand-compose.js，
// 与 OpenAI 兼容供应商共用——「只回新增条带、其余透明」这个结果形态是两个
// 供应商都必须遵守的契约，CEP 侧 applyExpand 靠它判断有没有裁切成功。

// 把「照片在画布里的位置」翻译成 out-painting 的四边偏移。
// 输入只送照片本身（不含透明区），所以输出 = 照片宽高 + 四边偏移 = 画布宽高，
// 三个数字天然对齐，不需要任何缩放或补偿。
// 返回 null 表示这一单不适合走参数化扩图（没有新增区，或尺寸越界）。
function planOutpaint(bounds, canvas) {
  if (!bounds || !canvas) return null;
  const left = Math.max(0, Math.round(bounds.left));
  const top = Math.max(0, Math.round(bounds.top));
  const right = Math.max(0, Math.round(bounds.right));
  const bottom = Math.max(0, Math.round(bounds.bottom));
  const offsets = {
    left_offset: left,
    top_offset: top,
    right_offset: Math.max(0, Math.round(canvas.width) - right),
    bottom_offset: Math.max(0, Math.round(canvas.height) - bottom)
  };
  // 四边都不加就是「没扩」，这一单本来就不该走到这里。
  if (!offsets.left_offset && !offsets.right_offset && !offsets.top_offset && !offsets.bottom_offset) return null;
  const inW = right - left;
  const inH = bottom - top;
  const outW = inW + offsets.left_offset + offsets.right_offset;
  const outH = inH + offsets.top_offset + offsets.bottom_offset;
  const sides = [inW, inH, outW, outH];
  if (sides.some((v) => v < OUTPAINT_MIN_SIDE || v > OUTPAINT_MAX_SIDE)) return null;
  return {
    offsets,
    rect: { left, top, right, bottom },
    output: { width: outW, height: outH },
    strips: expandStrips(canvas.width, canvas.height, { left, top, right, bottom })
  };
}

function createAliyunProvider({ fetchImpl = fetch, endpoint, apiKey, requestTimeoutMs = 30000 }) {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.cn-beijing.maas.aliyuncs.com')) {
    throw providerError('INVALID_ENDPOINT', '百炼业务空间地址无效。');
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    throw providerError('MISSING_API_KEY', '请先配置百炼 API Key。');
  }
  const root = base.origin;

  async function requestJson(url, init = {}, timeoutMs = requestTimeoutMs) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
      });
    } catch {
      throw providerError('ALIYUN_NETWORK', '无法连接百炼服务。');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw providerError('ALIYUN_RESPONSE', '百炼返回了无法识别的响应。');
    }
    if (!response.ok || payload.code) {
      const error = providerError('ALIYUN_REQUEST_FAILED', `百炼请求失败${payload.code ? `（${String(payload.code).replace(/[^A-Za-z0-9_]/g, '')}）` : ''}。`);
      // 上游原文只给内部判断用（比如「Model not exist」决定要不要降级），
      // 不往面板上抛——用户看不懂，也无从处置。
      error.upstreamCode = typeof payload.code === 'string' ? payload.code : '';
      error.upstreamMessage = typeof payload.message === 'string' ? payload.message : '';
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  }

  async function imageDataUrl(image) {
    const { pngBytes } = await decodeCapture(image);
    return encodeApiImage(pngBytes);
  }

  // 该业务空间的 Key 不允许对 multimodal 接口使用异步模式（会返回 403
  // does not support asynchronous calls），只能同步等到出图。同步调用本身就直接
  // 拿到结果，于是这里自造一个任务号把结果暂存，让外层的 poll 立刻返回，
  // 上层的「提交—轮询」架构完全不用改。
  // 三个缓存都带过期：任务被取消、或用户关掉面板后，download 那一步永远不会来，
  // 用普通 Map 的话这些 URL/参数会一直留着（syncResults 里还是几 MB 的 base64 图）。
  const syncResults = createTtlMap();
  // 结果 URL → 需要还原的目标尺寸（画布超出模型输出上限时做过降采样）
  const resizeTargets = createTtlMap();
  // 结果 URL → 窗口化扩图的合成参数（只回了接缝窗口，要贴回整张画布）
  const expandComposites = createTtlMap();
  // 参数化扩图是异步任务：composite 在 submit 时按 taskId 暂存，poll 拿到结果 URL
  // 之后再挂到 URL 上——download 只认 URL，两条链路最终汇到同一个 expandComposites。
  const outpaintComposites = createTtlMap();
  // 业务空间没上架 image-out-painting 时，每次请求都必然拿到 404 Model not exist。
  // 记住这个结论，后续扩图直接走指令式，不再白打一次注定失败的请求。
  let outpaintAvailable = true;

  // 参数化扩图（image-out-painting）。和指令式路径的区别不是「模型更好」，而是
  // **几何由参数决定**：四边各加多少像素是算出来的，模型只负责把这几条边画出来，
  // 没有任何机会重新安排画面里已有的东西。用户反馈的「键盘按键变大」「手腕重复」
  // 全都是模型重画整幅造成的，这条路从机制上就不会发生。
  // 这一步不适用/不可用时返回 null，调用方继续走原来的指令式路径。
  async function submitOutpaint(job) {
    if (!outpaintAvailable) return null;
    const { pngBytes } = await decodeCapture(job.image);
    const info = await inspectImage(pngBytes);
    const canvas = { width: info.width, height: info.height };
    const b = saneBounds(job.canvasBounds, canvas) || saneBounds(info.opaqueBounds, canvas);
    const plan = b ? planOutpaint(b, canvas) : null;
    if (!plan) return null;
    const base = await sharp(pngBytes)
      .extract({
        left: plan.rect.left,
        top: plan.rect.top,
        width: plan.rect.right - plan.rect.left,
        height: plan.rect.bottom - plan.rect.top
      })
      .png().toBuffer();
    let payload;
    try {
      payload = await requestJson(root + OUTPAINT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
        body: JSON.stringify({
          model: OUTPAINT_MODEL,
          // 只送照片本身：透明区不能送进去，否则 offsets 的基准就不是照片而是画布。
          input: { image_url: await encodeApiImage(base) },
          // best_quality 优先画质；limit_image_size 关掉——它会为省算力缩小输出，
          // 输出一旦不等于画布尺寸，接缝就得重采样，这条路径的意义就没了。
          parameters: { ...plan.offsets, best_quality: true, limit_image_size: false }
        }),
      }, 120000);
    } catch (error) {
      // 只有「模型不在这个业务空间」才值得悄悄换路。其它错误（限流、网络、
      // 参数被拒）必须原样抛出去，否则用户看到的是「怎么又变糊了」而无从追查。
      if (error.httpStatus === 404 && /model not exist/i.test(error.upstreamMessage || '')) {
        outpaintAvailable = false;
        process.stderr.write('[aliyun] 当前业务空间没有 image-out-painting 模型，扩图改用指令式\n');
        return null;
      }
      throw error;
    }
    const taskId = payload.output && payload.output.task_id;
    if (typeof taskId !== 'string' || !taskId) throw providerError('ALIYUN_RESPONSE', '百炼未返回任务编号。');
    outpaintComposites.set(taskId, {
      window: { left: 0, top: 0, right: canvas.width, bottom: canvas.height },
      strips: plan.strips,
      frame: canvas,
      bounds: b,
      base: pngBytes
    });
    process.stderr.write('[aliyun] 参数化扩图 offsets=' + JSON.stringify(plan.offsets)
      + ' 输入 ' + (plan.rect.right - plan.rect.left) + 'x' + (plan.rect.bottom - plan.rect.top)
      + ' → 输出 ' + plan.output.width + 'x' + plan.output.height + '\n');
    return {
      taskId,
      size: `${plan.output.width}*${plan.output.height}`,
      // out-painting 只接受图片和偏移量，没有提示词入口。这句话必须让用户看到，
      // 否则他会以为是提示词写得不对。
      notice: '这次用参数化扩图（按画布几何精确延伸），提示词不参与，延续内容由模型依据接缝自行推断。'
    };
  }

  async function submitInstruction(body) {
    const payload = await requestJson(root + MULTI_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 300000);
    const urls = [];
    for (const choice of (payload.output && payload.output.choices) || []) {
      for (const item of (choice.message && choice.message.content) || []) {
        if (item.type === 'image' && typeof item.image === 'string') urls.push(item.image);
      }
    }
    if (urls.length === 0) throw providerError('EMPTY_RESULT', '模型未返回图像。');
    const taskId = `sync-${randomUUID()}`;
    syncResults.set(taskId, urls);
    return { taskId, cost: { channel: 'aliyun', model: body.model, imageCount: urls.length } };
  }

  // 指令式模型没有扩图比例参数，改为把它要输出的画面先「铺好」：
  // 照片按边缘拉伸填满画布、延伸区做模糊，再让模型只负责把延伸区画实。
  async function prepareExpandTask(job) {
    const { pngBytes } = await decodeCapture(job.image);
    const info = await inspectImage(pngBytes);
    // 和 openai-compat 保持同一条规矩：Photoshop 传来的图层范围是几何真值，
    // 拿 alpha 反推只作备胎——照片边缘有半透明描边/投影时反推会偏大，
    // 条带被挤成几像素，合成出一张几乎全透明的图，「合并后扩图区就没了」。
    const canvas = { width: info.width, height: info.height };
    const b = saneBounds(job.canvasBounds, canvas) || saneBounds(info.opaqueBounds, canvas);
    if (!b) throw providerError('NO_EXPAND_AREA', '画布上看不出清晰的「原图 + 透明扩展区」。请先把画布拉大、让原图贴住其中一侧后重试。');
    // 画布大于模型输出上限时，整张送进去会被压到 2048 见方、回来再放大 1.4 倍，
    // 扩展区天生就比原照片糊一档——这跟模型能力无关，是送图方式的问题。
    // 改成只送「接缝附近的窗口」：新增条带 + 一截原照片作上下文，
    // 模型因此在原生分辨率下工作，也没机会去重画整张照片。
    const plan = info.width * info.height > MULTI_MAX_PIXELS ? planExpandWindow(info, b) : null;
    if (plan) {
      const winW = plan.window.right - plan.window.left;
      const winH = plan.window.bottom - plan.window.top;
      const base = await sharp(pngBytes)
        .extract({ left: plan.window.left, top: plan.window.top, width: winW, height: winH })
        .png().toBuffer();
      // 注意：窗口是画布的一块裁剪，照片在窗口内的位置要重新夹到窗口坐标系。
      // 直接把画布坐标减偏移会得到负数或超出窗口的尺寸，buildExpandInput 的
      // extract 会直接报错。
      const inner = {
        left: Math.max(0, b.left - plan.window.left),
        top: Math.max(0, b.top - plan.window.top),
        right: Math.min(winW, b.right - plan.window.left),
        bottom: Math.min(winH, b.bottom - plan.window.top)
      };
      const bytes = await buildExpandInput(base, { width: winW, height: winH }, inner);
      // composite 交给 download 阶段：模型只回了窗口那一块，
      // 要把条带抠出来贴回原画布尺寸（其余透明），apply 才有东西可裁。
      // bounds/base 一起带过去，合成层才能在接缝上做羽化与色差对齐——
      // 两个供应商都走 composeExpand，接缝处理必须一致，否则换渠道观感就变。
      return {
        bytes,
        size: `${winW}*${winH}`,
        target: null,
        composite: { window: plan.window, strips: plan.strips, frame: { width: info.width, height: info.height }, bounds: b, base: pngBytes },
        bounds: b,
        canvas
      };
    }
    // 只有在画布超出模型输出上限时才降采样并做 16 对齐（对齐后必须缩放回原尺寸）。
    // 没超限时直接传精确画布尺寸——对齐会改变宽高比，凭空引入一次重采样。
    // 对齐必须向下取整：这里 scale 已经贴着上限算过，round 会向上取整 16 的倍数，
    // 结果反而越过 MULTI_MAX_PIXELS（实测 2560×2880 会算成 1936×2176 = 4.21M），
    // 上游要么硬压要么报错，前一种更糟——压了没人知道。
    const downscale = info.width * info.height > MULTI_MAX_PIXELS;
    const scale = downscale ? Math.sqrt(MULTI_MAX_PIXELS / (info.width * info.height)) : 1;
    const fit16 = (v) => Math.max(16, Math.floor(v / 16) * 16);
    const apiW = downscale ? fit16(info.width * scale) : info.width;
    const apiH = downscale ? fit16(info.height * scale) : info.height;
    const scaled = {
      left: Math.round(b.left * apiW / info.width),
      top: Math.round(b.top * apiH / info.height),
      right: Math.round(b.right * apiW / info.width),
      bottom: Math.round(b.bottom * apiH / info.height),
    };
    scaled.right = Math.min(apiW, Math.max(scaled.left + 1, scaled.right));
    scaled.bottom = Math.min(apiH, Math.max(scaled.top + 1, scaled.bottom));
    const base = downscale
      ? await sharp(pngBytes).resize(apiW, apiH, { fit: 'fill' }).png().toBuffer()
      : pngBytes;
    const bytes = await buildExpandInput(base, { width: apiW, height: apiH }, scaled);
    // 退回整画布时，指令式模型（qwen-image-3.0-pro）无法只画一条带子——它收到的
    // 是「把画布向右扩」这句话 + 一整张已经填好的画布，于是按指令重画整幅。
    // 之前这条路不带 composite，download 就把这张重绘结果原样交回去了：照片区
    // 被它自己重新构图顶掉，而「只回新增条带、其余透明」是 CEP applyExpand 依赖
    // 的契约，破了这条契约等于让模型去改原图。
    // 双向扩图（右 + 下）一定会走到这里：两条带子的并集就是整幅画布，
    // planExpandWindow 里「窗口几乎等于整张画布」那一关直接判空。
    // 所以整画布路径也必须带 composite——模型画成什么样都只取新增条带。
    const strips = expandStrips(info.width, info.height, b);
    process.stderr.write('[aliyun] 扩图走整画布路径（窗口方案不适用），送出 '
      + apiW + 'x' + apiH + (downscale ? '（降采样 ' + (info.width / apiW).toFixed(2) + 'x）' : '')
      + '，合成时只取新增条带 ' + strips.length + ' 条\n');
    return {
      bytes,
      size: `${apiW}*${apiH}`,
      target: downscale ? { width: info.width, height: info.height } : null,
      composite: strips.length ? {
        window: { left: 0, top: 0, right: info.width, bottom: info.height },
        strips,
        frame: { width: info.width, height: info.height },
        bounds: b,
        base: pngBytes
      } : null,
      bounds: b,
      canvas
    };
  }

  async function submit(job) {
    if (job.operation === 'generate') {
      const payload = await requestJson(root + '/api/v1/services/aigc/image-generation/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
        body: JSON.stringify({
          model: 'wan2.7-image',
          input: { messages: [{ role: 'user', content: [{ text: job.prompt }] }] },
          parameters: { size: job.size, n: job.n, watermark: false, ...(job.seed === undefined ? {} : { seed: job.seed }) },
        }),
      });
      const taskId = payload.output && payload.output.task_id;
      if (typeof taskId !== 'string' || !taskId) throw providerError('ALIYUN_RESPONSE', '百炼未返回任务编号。');
      return { taskId, cost: { channel: 'aliyun', model: 'wan2.7-image', imageCount: job.n || 1 } };
    }

    // 选区编辑要靠 mask_image_url 指定改哪里，只有 wanx2.1-imageedit 这个老接口支持；
    // 带遮罩的扩图同理。其余情况全部交给画质更好的指令式模型。
    if (job.operation === 'editMasked' || (job.operation === 'expand' && job.mask)) {
      return submitLegacy(job);
    }

    // 扩图先试参数化路径：几何由参数锁定，模型碰不到原图内容。
    // 尺寸越界或该业务空间没上架这个模型时返回 null，落到下面的指令式路径。
    if (job.operation === 'expand') {
      const parameterized = await submitOutpaint(job);
      if (parameterized) return parameterized;
    }

    const content = [];
    let size;
    let target = null;
    let composite = null;
    let prompt = job.prompt;
    if (job.operation === 'expand') {
      const prepared = await prepareExpandTask(job);
      content.push({ image: await encodeApiImage(prepared.bytes) });
      size = prepared.size;
      target = prepared.target;
      composite = prepared.composite || null;
      prompt = buildExpandPrompt(prompt, { bounds: prepared.bounds, canvas: prepared.canvas, masked: false });
    } else {
      const { pngBytes } = await decodeCapture(job.image);
      const meta = await sharp(pngBytes).metadata();
      const downscale = meta.width * meta.height > MULTI_MAX_PIXELS;
      const scale = downscale ? Math.sqrt(MULTI_MAX_PIXELS / (meta.width * meta.height)) : 1;
      const apiW = downscale ? fit16(meta.width * scale) : meta.width;
      const apiH = downscale ? fit16(meta.height * scale) : meta.height;
      const base = downscale
        ? await sharp(pngBytes).resize(apiW, apiH, { fit: 'fill' }).png().toBuffer()
        : pngBytes;
      content.push({ image: await encodeApiImage(base) });
      size = `${apiW}*${apiH}`;
      if (downscale) target = { width: meta.width, height: meta.height };
    }
    content.push({ text: prompt });

    const submitted = await submitInstruction({
      model: EDIT_MODEL,
      input: { messages: [{ role: 'user', content }] },
      parameters: { n: job.n, size, watermark: false, prompt_extend: false, ...(job.seed === undefined ? {} : { seed: job.seed }) },
    });
    if (target) for (const url of syncResults.get(submitted.taskId) || []) resizeTargets.set(url, target);
    if (composite) for (const url of syncResults.get(submitted.taskId) || []) expandComposites.set(url, composite);
    return submitted;
  }

  async function submitLegacy(job) {
    const path = '/api/v1/services/aigc/image2image/image-synthesis';
    let imageUrl;
    const input = { prompt: job.prompt };
    const parameters = { n: job.n, ...(job.seed === undefined ? {} : { seed: job.seed }) };
    if (job.operation === 'editMasked') {
      input.function = 'description_edit_with_mask';
      imageUrl = await imageDataUrl(job.image);
      const { maskBytes } = await decodeCapture(job.image, job.mask);
      const binary = await sharp(maskBytes).removeAlpha().greyscale().threshold(128).png().toBuffer();
      input.mask_image_url = `data:image/png;base64,${binary.toString('base64')}`;
    } else if (job.operation === 'expand') {
      input.function = 'expand';
      const { pngBytes, maskBytes } = await decodeCapture(job.image, job.mask);
      const prepared = await prepareExpansion(pngBytes, maskBytes);
      imageUrl = await encodeApiImage(prepared.originalPng);
      parameters.top_scale = prepared.topScale;
      parameters.right_scale = prepared.rightScale;
      parameters.bottom_scale = prepared.bottomScale;
      parameters.left_scale = prepared.leftScale;
    } else {
      throw providerError('INVALID_OPERATION', '不支持的图像操作。');
    }
    if (imageUrl) input.base_image_url = imageUrl;
    const payload = await requestJson(root + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model: 'wanx2.1-imageedit', input, parameters }),
    });
    const taskId = payload.output && payload.output.task_id;
    if (typeof taskId !== 'string' || !taskId) throw providerError('ALIYUN_RESPONSE', '百炼未返回任务编号。');
    return { taskId, cost: { channel: 'aliyun', model: 'wanx2.1-imageedit', imageCount: job.n || 1 } };
  }

  async function poll(taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw providerError('INVALID_TASK_ID', '任务编号无效。');
    // 指令式模型是同步出图的，结果提交时就已拿到，不必再去远端轮询。
    const done = syncResults.get(taskId);
    if (done) {
      syncResults.delete(taskId);
      return { status: 'SUCCEEDED', resultUrls: done, errorCode: null };
    }
    const payload = await requestJson(root + '/api/v1/tasks/' + encodeURIComponent(taskId));
    const output = payload.output || {};
    const resultUrls = [];
    for (const item of output.results || []) {
      if (typeof item.url === 'string') resultUrls.push(item.url);
    }
    for (const choice of output.choices || []) {
      for (const item of (choice.message && choice.message.content) || []) {
        if (item.type === 'image' && typeof item.image === 'string') resultUrls.push(item.image);
      }
    }
    // 参数化扩图是异步任务，composite 先按 taskId 存着；这里拿到真实结果 URL
    // 之后才转挂到 URL 上——download 只认 URL，两条链路最终汇到同一个 map。
    const pending = outpaintComposites.get(taskId);
    if (pending) {
      outpaintComposites.delete(taskId);
      for (const url of resultUrls) expandComposites.set(url, pending);
    }
    return { status: output.task_status || 'UNKNOWN', resultUrls, errorCode: output.code || null };
  }

  async function download(url) {
    let target;
    try { target = new URL(url); } catch { throw providerError('RESULT_URL', '结果地址无效。'); }
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.aliyuncs.com')) {
      throw providerError('RESULT_URL', '结果地址无效。');
    }
    let response;
    try { response = await fetchImpl(target.href, { signal: AbortSignal.timeout(requestTimeoutMs) }); } catch { throw providerError('RESULT_DOWNLOAD', '结果下载失败。'); }
    if (!response.ok) throw providerError('RESULT_DOWNLOAD', '结果下载失败。');
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); }
    catch { throw providerError('RESULT_DOWNLOAD', '结果下载失败。'); }
    if (bytes.length === 0 || bytes.length > 30 * 1024 * 1024) throw providerError('RESULT_DOWNLOAD', '结果文件无效。');
    // 窗口化扩图：模型只回了接缝那一块，先裁成条带贴回画布尺寸再往下走，
    // 这样 apply 阶段拿到的还是「画布大小、只有新增区有像素」的图。
    const composite = expandComposites.get(url);
    if (composite) {
      expandComposites.delete(url);
      // 合成层会先按窗口尺寸重采样，整画布路径下窗口就是画布本身，
      // 所以 resizeTargets 那条降采样还原记录在这里是多余的，一起清掉免得留垃圾。
      resizeTargets.delete(url);
      try { return await composeExpand(bytes, composite); }
      catch { throw providerError('RESULT_IMAGE', '结果图像无法读取。'); }
    }
    // 画布超出模型输出上限时送的是降采样图，这里按原画布尺寸还原，
    // 否则 apply 阶段会因尺寸对不上而放弃贴合。
    const hint = resizeTargets.get(url);
    if (hint) resizeTargets.delete(url);
    try {
      const image = sharp(bytes);
      return await (hint ? image.resize(hint.width, hint.height, { fit: 'fill' }) : image).png().toBuffer();
    } catch {
      throw providerError('RESULT_DOWNLOAD', '结果图像无法读取。');
    }
  }

  return { submit, poll, download };
}

module.exports = { createAliyunProvider };
