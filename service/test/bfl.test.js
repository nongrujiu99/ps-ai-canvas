const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  createBflProvider,
  isBflBaseUrl,
  isBflChannel,
  bflRoot,
  modelFromBaseUrl,
  parseRequestedSize,
  hasChinese,
  TEXT_MODELS,
  DEFAULT_TEXT_MODEL
} = require('../src/providers/bfl');

const BASE = 'https://api.bfl.ai';
const KEY = 'bfl_test_key_not_real';
const SAMPLE = 'https://delivery-prod.bfl.ai/result/abc.png';

// ── 假上游 ────────────────────────────────────────────────────────────────
// 三件事各自有明确形状：提交回 {id, polling_url}、轮询回 {status, result}、
// 下载回图片字节。混在一个 mock 里最容易写错，所以按 URL 分流。
function upstream({ submit = { id: 'task-1', polling_url: BASE + '/v1/get_result?id=task-1' }, polls = [{ status: 'Ready', result: { sample: SAMPLE } }], image } = {}) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (init.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify(submit) };
    }
    if (target.includes('get_result')) {
      const body = polls[Math.min(index++, polls.length - 1)];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => image };
  };
  return { calls, fetchImpl };
}

function failure(status, body) {
  return async () => ({ ok: false, status, text: async () => JSON.stringify(body) });
}

// 透明画布 + 中间一块不透明照片。扩图的几何全靠这张图验证。
async function canvasWithPhoto(W, H, photo) {
  const px = Buffer.alloc(W * H * 4, 0);
  for (let y = photo.top; y < photo.bottom; y++) {
    for (let x = photo.left; x < photo.right; x++) {
      const i = (y * W + x) * 4;
      px[i] = 0x40; px[i + 1] = 0x80; px[i + 2] = 0xc0; px[i + 3] = 255;
    }
  }
  return sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function solid(W, H, background) {
  return sharp({ create: { width: W, height: H, channels: 3, background } }).png().toBuffer();
}

const rawCapture = (png) => ({ kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') });

// ── 地址归一化 ────────────────────────────────────────────────────────────
test('bfl base url collapses every form the user might paste', () => {
  assert.equal(bflRoot('https://api.bfl.ai'), BASE + '/v1');
  assert.equal(bflRoot('https://api.bfl.ai/'), BASE + '/v1');
  assert.equal(bflRoot('https://api.bfl.ai/v1'), BASE + '/v1');
  // 整条端点粘进来：剥掉模型段，不能出现 /v1/v1 或 /v1/flux-2-pro/v1
  assert.equal(bflRoot('https://api.bfl.ai/v1/flux-2-pro-preview'), BASE + '/v1');
  assert.equal(modelFromBaseUrl('https://api.bfl.ai/v1/flux-2-pro-preview'), 'flux-2-pro-preview');
  assert.equal(modelFromBaseUrl('https://api.bfl.ai/v1'), '');
});

test('bfl channel detection does not swallow ordinary relays', () => {
  assert.equal(isBflBaseUrl(BASE), true);
  assert.equal(isBflBaseUrl('https://api.eu.bfl.ai/v1'), true);
  assert.equal(isBflBaseUrl('https://ai.comfly.org/v1'), false);
  // 显式标了 kind 就认，哪怕地址被人反代过
  assert.equal(isBflChannel({ kind: 'bfl', baseUrl: 'https://relay.example.com/v1' }), true);
  assert.equal(isBflChannel({ baseUrl: 'https://ai.comfly.org/v1' }), false);
});

test('requested size accepts both the panel format and the legacy tier', () => {
  assert.deepEqual(parseRequestedSize('2048*2560'), { width: 2048, height: 2560 });
  assert.deepEqual(parseRequestedSize('1024x1024'), { width: 1024, height: 1024 });
  assert.deepEqual(parseRequestedSize('2K'), { width: 2048, height: 2048 });
  assert.equal(parseRequestedSize(''), null);
});

// ── 文生图 ────────────────────────────────────────────────────────────────
test('text-to-image posts width and height, and authenticates with x-key', async () => {
  const image = await solid(1024, 1024, '#7a5230');
  const { calls, fetchImpl } = upstream({ image });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'flux-2-pro-preview' });

  const submitted = await provider.submit({ operation: 'generate', prompt: 'a quiet street at dawn', size: '1024*1280', n: 1 });
  assert.equal(calls[0].url, BASE + '/v1/flux-2-pro-preview');
  assert.equal(calls[0].init.headers['x-key'], KEY);
  assert.equal(calls[0].init.headers.Authorization, undefined, '带 Bearer 会被 BFL 直接 401');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.width, 1024);
  assert.equal(body.height, 1280);
  assert.equal(body.output_format, 'png');
  // 种子必须真发出去：留空时服务端摇一个，并回面板
  assert.ok(Number.isInteger(body.seed));
  assert.equal(submitted.seed, body.seed);

  const polled = await provider.poll(submitted.taskId);
  assert.equal(polled.status, 'SUCCEEDED');
  assert.deepEqual(polled.resultUrls, [SAMPLE]);
  const out = await provider.download(SAMPLE);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 1024);
  assert.equal(meta.height, 1280, '选什么得什么，模型给的尺寸不对也要补齐');
});

test('one image per request: n>1 turns into a notice instead of a silent drop', async () => {
  const { fetchImpl } = upstream({ image: await solid(64, 64, '#fff') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  const submitted = await provider.submit({ operation: 'generate', prompt: 'x', size: '1024*1024', n: 3 });
  assert.match(submitted.notice, /一次只出一张/);
});

test('chinese prompt gets a warning, because flux is an english model', async () => {
  const { fetchImpl } = upstream({ image: await solid(64, 64, '#fff') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  assert.equal(hasChinese('一只猫'), true);
  const submitted = await provider.submit({ operation: 'generate', prompt: '一只在窗台上的猫', size: '1024*1024' });
  assert.match(submitted.notice, /英文模型/);
});

// ── 状态映射 ──────────────────────────────────────────────────────────────
test('poll maps pending and moderation states instead of treating them as failures', async () => {
  const pending = createBflProvider({
    fetchImpl: upstream({ polls: [{ status: 'Pending' }, { status: 'Ready', result: { sample: SAMPLE } }], image: await solid(64, 64, '#fff') }).fetchImpl,
    baseUrl: BASE, apiKey: KEY
  });
  const submitted = await pending.submit({ operation: 'generate', prompt: 'x', size: '1024*1024' });
  assert.equal((await pending.poll(submitted.taskId)).status, 'PENDING');
  assert.equal((await pending.poll(submitted.taskId)).status, 'SUCCEEDED');

  const moderated = createBflProvider({
    fetchImpl: upstream({ polls: [{ status: 'Content Moderated' }] }).fetchImpl,
    baseUrl: BASE, apiKey: KEY
  });
  const blocked = await moderated.submit({ operation: 'generate', prompt: 'x', size: '1024*1024' });
  // 第一次被拦先去放宽档位重试（见下面那条用例），重试后仍被拦才判失败
  assert.equal((await moderated.poll(blocked.taskId)).status, 'RUNNING');
  const result = await moderated.poll(blocked.taskId);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'BFL_MODERATED');
  // 文案要说人话：用户得知道是审核拦的，不是插件坏了
  assert.match(result.errorMessage, /安全策略/);
});

test('credits and quota failures are told apart from auth failures', async () => {
  const noCredits = createBflProvider({ fetchImpl: failure(402, { detail: 'insufficient credits' }), baseUrl: BASE, apiKey: KEY });
  await assert.rejects(
    () => noCredits.submit({ operation: 'generate', prompt: 'x', size: '1024*1024' }),
    (error) => error.code === 'BFL_NO_CREDITS' && /余额不足/.test(error.message)
  );

  const badKey = createBflProvider({ fetchImpl: failure(401, { detail: 'invalid key' }), baseUrl: BASE, apiKey: KEY });
  await assert.rejects(
    () => badKey.submit({ operation: 'generate', prompt: 'x', size: '1024*1024' }),
    (error) => error.code === 'BFL_AUTH_FAILED' && /x-key/.test(error.message)
  );

  const badBody = createBflProvider({ fetchImpl: failure(422, { detail: [{ msg: 'width must be a multiple of 32' }] }), baseUrl: BASE, apiKey: KEY });
  await assert.rejects(
    () => badBody.submit({ operation: 'generate', prompt: 'x', size: '1024*1024' }),
    (error) => error.code === 'BFL_INVALID_REQUEST' && /multiple of 32/.test(error.message)
  );
});

// ── 扩图几何 ──────────────────────────────────────────────────────────────
// 这是接这个渠道的**唯一理由**：四边像素由我们算好直接告诉模型，
// 而不是把整张画布丢进去让它重画。
test('expand sends the photo region plus four pixel offsets, not the whole canvas', async () => {
  const W = 1024, H = 1024;
  const photo = { left: 112, top: 212, right: 912, bottom: 812 };
  const png = await canvasWithPhoto(W, H, photo);
  const reply = await solid(W, H, '#d8b040');
  const { calls, fetchImpl } = upstream({ image: reply });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  const submitted = await provider.submit({
    operation: 'expand',
    image: rawCapture(png),
    canvasBounds: photo,
    prompt: '',
    n: 1
  });

  assert.equal(calls[0].url, BASE + '/v1/flux-pro-1.0-expand');
  const body = JSON.parse(calls[0].init.body);
  const sent = await sharp(Buffer.from(body.image, 'base64')).metadata();
  assert.equal(sent.width, 800, '送出去的必须是照片本身，不能带透明画布');
  assert.equal(sent.height, 600);
  assert.equal(body.left, 112);
  assert.equal(body.top, 212);
  assert.equal(body.right, 112);
  assert.equal(body.bottom, 212);
  // 框架兜底的中文提示词不能发给英文模型
  assert.equal(body.prompt, undefined);

  await provider.poll(submitted.taskId);
  const out = await provider.download(SAMPLE);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, W);
  assert.equal(meta.height, H);

  const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  // 契约：原照片区必须是透明的——PS 那边靠自己的图层贴回，这一层要是带着
  // 原像素，等于把照片又盖了一遍，边缘会出现重影。
  assert.equal(at(512, 512).a, 0, '原照片区必须保持透明');
  // 新增区得有模型画出来的内容（取远离接缝的一点，避开羽化带）
  const corner = at(20, 20);
  assert.ok(corner.a > 200, '新增区必须不透明，实际 alpha=' + corner.a);
  assert.ok(corner.r > 100 && corner.g > 60, '新增区应当有模型画出来的颜色，实际 ' + [corner.r, corner.g, corner.b].join(','));
});

// ── 选区编辑 ──────────────────────────────────────────────────────────────
test('expand 收紧到真正有像素的范围，不把透明边发给模型', async () => {
  const W = 1120, H = 1120;
  const photo = { left: 112, top: 212, right: 912, bottom: 812 };
  const png = await canvasWithPhoto(W, H, photo);
  // 图层框比内容大一圈——用户缩放/移动过图层、或图层边缘留了空白就是这样。
  // 按它裁会把一条透明边一起送给 BFL，而带透明的底图会被判成 Content Moderated
  // （2026-11-14 实测：同一张照片、同样输出尺寸，带 200px 透明带必失败，裁掉必成功）。
  const declared = { left: 100, top: 200, right: 920, bottom: 820 };
  const reply = await solid(W, H, '#d8b040');
  const { calls, fetchImpl } = upstream({ image: reply });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  await provider.submit({
    operation: 'expand',
    image: rawCapture(png),
    canvasBounds: declared,
    prompt: '',
    n: 1
  });

  const body = JSON.parse(calls[0].init.body);
  const sent = await sharp(Buffer.from(body.image, 'base64')).metadata();
  assert.equal(sent.width, 800, '送出去的必须是真正有像素的那块');
  assert.equal(sent.height, 600);
  assert.equal(sent.hasAlpha, false, '底图不能带 alpha，否则上游直接判违规');
  // 收紧之后四边偏移要跟着变大，否则画布对不上
  assert.equal(body.left, 112);
  assert.equal(body.top, 212);
  assert.equal(body.right, W - 912);
  assert.equal(body.bottom, H - 812);
});

test('选区编辑的底图同样不许带透明，但尺寸必须还是整张画布', async () => {
  const W = 512, H = 512;
  // 底部留一条透明——扩图区或隐藏图层都会造成这种情况
  const png = await canvasWithPhoto(W, H, { left: 0, top: 0, right: W, bottom: 400 });
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await solid(120, 120, '#ffffff'), left: 200, top: 200 }])
    .png().toBuffer();
  const { calls, fetchImpl } = upstream({ image: await solid(W, H, '#204a80') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  await provider.submit({
    operation: 'editMasked',
    image: rawCapture(png),
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    prompt: 'a patch',
    n: 1
  });

  const body = JSON.parse(calls[0].init.body);
  const sent = await sharp(Buffer.from(body.image, 'base64')).metadata();
  // 这里不能裁：mask 是按整张画布算的，只能压平
  assert.equal(sent.width, W);
  assert.equal(sent.height, H);
  assert.equal(sent.hasAlpha, false, '带透明会被上游判成 Content Moderated');
});

test('出图审核拦下时自动放宽档位重试一次，而不是直接让人换图', async () => {
  // 实测：2 档对「手持遥控器的产品照」连拦两次，6 档一次就过。
  // 所以被拦时先自己放宽档位重来，别让用户去猜。
  const W = 1024, H = 1024;
  const png = await canvasWithPhoto(W, H, { left: 112, top: 212, right: 912, bottom: 812 });
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (init.method === 'POST') {
      const submit = calls.filter((call) => call.init && call.init.method === 'POST').length;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-' + submit, polling_url: BASE + '/v1/get_result?id=task-' + submit }) };
    }
    if (target.includes('get_result')) {
      polls += 1;
      // 第一次拦下，重试后成功
      const body = polls === 1 ? { status: 'Content Moderated' } : { status: 'Ready', result: { sample: SAMPLE } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => png };
  };
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  const submitted = await provider.submit({ operation: 'expand', image: rawCapture(png), canvasBounds: { left: 112, top: 212, right: 912, bottom: 812 }, prompt: '', n: 1 });

  const first = JSON.parse(calls[0].init.body);
  assert.equal(first.safety_tolerance, 2, '第一次仍然用普通档位');

  const moderated = await provider.poll(submitted.taskId);
  assert.equal(moderated.status, 'RUNNING', '被拦不等于失败，要先重试');
  const submits = calls.filter((call) => call.init && call.init.method === 'POST');
  assert.equal(submits.length, 2, '应当重新提交一次');
  assert.equal(JSON.parse(submits[1].init.body).safety_tolerance, 6, '重试要用最宽松档位');
  assert.equal(submits[1].url, submits[0].url, '重试的仍是同一个端点');

  const done = await provider.poll(submitted.taskId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.resultUrls[0], SAMPLE);
});

test('放宽档位重试后仍被拦，才报失败', async () => {
  const W = 512, H = 512;
  const png = await canvasWithPhoto(W, H, { left: 0, top: 0, right: 400, bottom: 512 });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (init.method === 'POST') {
      const submit = calls.filter((call) => call.init && call.init.method === 'POST').length;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-' + submit, polling_url: BASE + '/v1/get_result?id=task-' + submit }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Content Moderated' }) };
  };
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  const submitted = await provider.submit({ operation: 'expand', image: rawCapture(png), canvasBounds: { left: 0, top: 0, right: 400, bottom: 512 }, prompt: '', n: 1 });

  assert.equal((await provider.poll(submitted.taskId)).status, 'RUNNING');
  const failed = await provider.poll(submitted.taskId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'BFL_MODERATED');
  assert.match(failed.errorMessage, /重试/);
  // 只重试一次，不能变成无限循环
  assert.equal(calls.filter((call) => call.init && call.init.method === 'POST').length, 2);
});

test('masked edit hands the real mask to the model and keeps outside pixels untouched', async () => {
  const W = 1024, H = 1024;
  const base = await solid(W, H, '#204a80');
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await solid(200, 200, '#ffffff'), left: 412, top: 412 }])
    .png().toBuffer();
  const reply = await solid(W, H, '#c02020');
  const { calls, fetchImpl } = upstream({ image: reply });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  const submitted = await provider.submit({
    operation: 'editMasked',
    image: rawCapture(base),
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    prompt: 'a red patch',
    n: 1
  });

  assert.equal(calls[0].url, BASE + '/v1/flux-pro-1.0-fill');
  const body = JSON.parse(calls[0].init.body);
  // 整张图 + 原 mask 一起送：mask 是模型的条件，不是我们事后裁切的依据
  const sentImage = await sharp(Buffer.from(body.image, 'base64')).metadata();
  const sentMask = await sharp(Buffer.from(body.mask, 'base64')).metadata();
  assert.equal(sentImage.width, W);
  assert.equal(sentMask.width, W);
  assert.equal(body.prompt, 'a red patch');

  await provider.poll(submitted.taskId);
  const out = await provider.download(SAMPLE);
  const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  // 选区内：用模型给的红色
  assert.deepEqual(at(512, 512), [0xc0, 0x20, 0x20]);
  // 选区外：一个像素都不能动
  assert.deepEqual(at(100, 100), [0x20, 0x4a, 0x80]);
});

// 本次真根因：PS 导出的抓图 PNG 带 alpha 通道，但 alpha 全 255（inspect 判定
// transparentBounds=null、transparentCount=0）。BFL 按解码后的 raw 算体积，
// 2048x2560 的 RGBA = 20.00MB 正好顶线被 422 拒；去 alpha 变 RGB 只有 15MB。
// 所以「没有透明像素」不代表「可以带 alpha 通道发出去」——必须无条件去掉。
test('带 alpha 通道但全不透明的图，fill 也要去掉 alpha（避免 BFL 按 RGBA 算到 20MB）', async () => {
  const W = 1024, H = 1024;
  // 造一张带 alpha 通道、但 alpha 全 255 的 PNG
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = 60; px[i * 4 + 1] = 90; px[i * 4 + 2] = 130; px[i * 4 + 3] = 255; }
  const withAlpha = await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  assert.equal((await sharp(withAlpha).metadata()).hasAlpha, true, '夹具必须带 alpha 通道');
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await solid(200, 200, '#ffffff'), left: 400, top: 400 }])
    .png().toBuffer();
  const { calls, fetchImpl } = upstream({ image: await solid(W, H, '#204a80') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  await provider.submit({
    operation: 'editMasked',
    image: rawCapture(withAlpha),
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    prompt: 'x', n: 1
  });

  const body = JSON.parse(calls[0].init.body);
  const sent = await sharp(Buffer.from(body.image, 'base64')).metadata();
  assert.equal(sent.hasAlpha, false, '发给 BFL 的图必须没有 alpha 通道');
  assert.equal(sent.width, W, '尺寸不能变，否则 mask 对不齐');
  assert.equal(sent.height, H);
});

test('大图 fill 超过上传上限时转 JPEG，尺寸不变、mask 仍原样', async () => {
  const crypto = require('node:crypto');
  const W = 2400, H = 2400;
  // 纯随机像素让 PNG 压不动（实测 16.5MB），稳定越过 12MB 阈值
  const noise = await sharp(crypto.randomBytes(W * H * 3), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  assert.ok(noise.length > 12 * 1048576, '夹具本身要够大，否则测不到转换分支');
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await solid(300, 300, '#ffffff'), left: 900, top: 900 }])
    .png().toBuffer();
  const { calls, fetchImpl } = upstream({ image: await solid(W, H, '#204a80') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  await provider.submit({
    operation: 'editMasked',
    image: rawCapture(noise),
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    prompt: 'a patch',
    n: 1
  });

  const body = JSON.parse(calls[0].init.body);
  const sentImageBuf = Buffer.from(body.image, 'base64');
  const sentImage = await sharp(sentImageBuf).metadata();
  const sentMask = await sharp(Buffer.from(body.mask, 'base64')).metadata();
  assert.equal(sentImage.format, 'jpeg', '超限底图要转 JPEG 才能避开 20MB 上限');
  assert.ok(sentImageBuf.length < noise.length, '转换后体积必须真的变小');
  assert.equal(sentImage.hasAlpha, false, 'JPEG 天然无 alpha');
  assert.equal(sentImage.width, W, '尺寸不能变，否则 mask 对不齐');
  assert.equal(sentImage.height, H);
  assert.equal(sentMask.format, 'png', 'mask 不能被转换，边界要保精确');
  assert.equal(sentMask.width, W);
});

test('小图 fill 保持 PNG，只去 alpha 不做无谓转码', async () => {
  const W = 512, H = 512;
  const base = await solid(W, H, '#204a80');
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await solid(120, 120, '#ffffff'), left: 200, top: 200 }])
    .png().toBuffer();
  const { calls, fetchImpl } = upstream({ image: await solid(W, H, '#c02020') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  await provider.submit({
    operation: 'editMasked',
    image: rawCapture(base),
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    prompt: 'x', n: 1
  });
  const body = JSON.parse(calls[0].init.body);
  const sent = await sharp(Buffer.from(body.image, 'base64')).metadata();
  assert.equal(sent.format, 'png', '没超限就保持 PNG，零额外损失');
});

// 关键场景：高分辨率、低细节纯色图。PNG 文件可能压到几百 KB（不触发按文件字节的
// 转 JPEG 分支），但解码后 raw = w*h*3 远超 BFL 20MB 硬限。旧代码这时静默发出去、
// 上游 422，用户只看到「file size exceeds 20MB」而猜不到是画布太大。现在要如实提示。
test('raw 超 20MB 但文件字节很小时，fill 也如实提示尺寸风险（不静默 422）', async () => {
  const W = 3000, H = 3000; // raw RGB = 27MB > 20MB；纯色 PNG 文件却很小
  const base = await solid(W, H, '#204a80');
  assert.ok(base.length < 12 * 1048576, '夹具是纯色大图，文件字节应远低于 12MB 转换线');
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await solid(200, 200, '#ffffff'), left: 1400, top: 1400 }])
    .png().toBuffer();
  const { calls, fetchImpl } = upstream({ image: await solid(64, 64, '#c02020') });
  const provider = createBflProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  const result = await provider.submit({
    operation: 'editMasked',
    image: rawCapture(base),
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    prompt: 'x', n: 1
  });

  assert.match(result.notice, /超过 BFL 20MB 上限/, 'raw 超限必须给出面板可见的提示');
  assert.match(result.notice, /缩小选区/, '提示要可执行，而不是让用户猜');
  const body = JSON.parse(calls[0].init.body);
  const sent = await sharp(Buffer.from(body.image, 'base64')).metadata();
  assert.equal(sent.format, 'png', '文件字节没超限就不转 JPEG（转了也救不了 raw）');
});

test('models list stays short and does not include kontext', () => {
  assert.ok(TEXT_MODELS.includes(DEFAULT_TEXT_MODEL));
  assert.ok(TEXT_MODELS.every((id) => !/kontext/i.test(id)), 'kontext 只认 4 档 aspect_ratio，放进文生图会静默改比例');
});

// ── 轮询的 404 ────────────────────────────────────────────────────────────
// 实测事实：任务跑在区域集群上（polling_url 指向 api.us7.bfl.ai），
// 拿主域名 api.bfl.ai/v1/get_result 去查，即便任务成功也一律 404 Task not found。
// 也就是说 404 不一定代表「任务没了」，有时只是「查的地方不对 / 集群间还没同步」。
// 一次 404 就判死，会把真正在跑的任务杀掉，用户看到的是「BFL 生成失败」而钱已经花了。
test('轮询偶尔查不到任务时继续等，不把在跑的任务判死', async () => {
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-gap', polling_url: BASE + '/v1/get_result?id=task-gap' }) };
    if (String(url).includes('get_result')) {
      polls++;
      if (polls <= 2) return { ok: false, status: 404, text: async () => JSON.stringify({ id: 'task-gap', status: 'Task not found' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Ready', result: { sample: SAMPLE } }) };
    }
    throw new Error('不该走到这里');
  };
  const provider = createBflProvider({ apiKey: KEY, baseUrl: BASE, model: 'flux-pro-1.1', fetchImpl });
  const { taskId } = await provider.submit({ operation: 'generate', prompt: 'a vase' });

  assert.equal((await provider.poll(taskId)).status, 'RUNNING', '第一次查不到只能当没查到');
  assert.equal((await provider.poll(taskId)).status, 'RUNNING', '第二次也一样');
  const done = await provider.poll(taskId);
  assert.equal(done.status, 'SUCCEEDED', '第三次拿到 Ready 就是成功');
  assert.deepEqual(done.resultUrls, [SAMPLE]);
});

test('连续三次查不到才认定任务真的没了，且文案不再让你去改模型名', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-lost', polling_url: BASE + '/v1/get_result?id=task-lost' }) };
    return { ok: false, status: 404, text: async () => JSON.stringify({ status: 'Task not found' }) };
  };
  const provider = createBflProvider({ apiKey: KEY, baseUrl: BASE, model: 'flux-pro-1.1', fetchImpl });
  const { taskId } = await provider.submit({ operation: 'generate', prompt: 'a vase' });

  await provider.poll(taskId);
  await provider.poll(taskId);
  await assert.rejects(() => provider.poll(taskId), (error) => {
    assert.equal(error.code, 'BFL_TASK_GONE');
    assert.doesNotMatch(error.message, /模型名/, '轮询阶段的 404 和模型名无关，说成模型名会让人改坏一个本来正确的配置');
    return true;
  });
});

test('提交时的 404 仍然指向模型名/地址，两种 404 不能混为一谈', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ detail: 'Not Found' }) });
  const provider = createBflProvider({ apiKey: KEY, baseUrl: BASE, model: 'no-such-model', fetchImpl });
  await assert.rejects(() => provider.submit({ operation: 'generate', prompt: 'a vase' }), (error) => {
    assert.equal(error.code, 'BFL_MODEL_MISSING');
    assert.match(error.message, /模型名/);
    return true;
  });
});

// ── 响应体卡住 ────────────────────────────────────────────────────────────
// 实测：走 HTTPS_PROXY 时，响应头能正常到（HTTP 200），body 却一直读不到。
// 原来的写法在拿到响应头就 clearTimeout，于是整个请求无限挂着——
// 面板上表现为「测试中…」「生成中」永远不结束，用户只能重启服务。
// 头到手不等于请求完成，超时保护必须覆盖到 body。
test('拿到响应头但读不到 body 时按超时失败，不会无限挂住', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    // 永不 settle：模拟代理只转发了响应头
    text: () => new Promise(() => {})
  });
  const provider = createBflProvider({ apiKey: KEY, baseUrl: BASE, model: 'flux-pro-1.1', fetchImpl, requestTimeoutMs: 120 });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: 'a vase' }),
    (error) => {
      assert.equal(error.code, 'BFL_TIMEOUT');
      assert.match(error.message, /响应头/, '要说清楚是「头到了、体没到」，否则用户会去改 Key 或模型名');
      return true;
    }
  );
});
