const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createAliyunProvider } = require('../src/providers/aliyun');

const endpoint = 'https://workspace.cn-beijing.maas.aliyuncs.com';
const image = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + Buffer.from('fixture').toString('base64') };

function withFetch(responseBody, status = 200) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    // 这几条用例验证的是指令式路径的契约。参数化扩图现在优先，但当前业务空间
    // 本来就没上架 image-out-painting（实测 404 Model not exist），所以这里让它
    // 探测失败、把扩图交回指令式分支——刻意不记进 requests，保持索引断言不变。
    if (String(url).endsWith('/image2image/out-painting')) {
      return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'Model not exist.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    requests.push({ url, init });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  };
  return { requests, provider: createAliyunProvider({ fetchImpl, endpoint, apiKey: 'secret-test-key' }) };
}

test('whole edit goes to the instruction-based multimodal model, not the legacy one', async () => {
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#345678' } }).png().toBuffer();
  const img = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') };
  const { requests, provider } = withFetch({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://example.oss-cn-beijing.aliyuncs.com/a.png' }] } }] } });
  const submitted = await provider.submit({ operation: 'editWhole', prompt: '把天空改为黄昏', image: img, n: 1, strength: 0.7 });
  assert.match(requests[0].url, /multimodal-generation\/generation$/);
  assert.equal(requests[0].init.headers['X-DashScope-Async'], undefined);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-test-key');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'qwen-image-3.0-pro');
  assert.equal(body.parameters.size, '64*48');
  assert.deepEqual(body.input.messages[0].content.map((part) => Object.keys(part)[0]), ['image', 'text']);
  assert.equal(body.input.messages[0].content[1].text, '把天空改为黄昏');
  // 同步模型提交时结果已到手，轮询应立即成功，不再打远端任务接口。
  assert.equal((await provider.poll(submitted.taskId)).status, 'SUCCEEDED');
  assert.equal(requests.length, 1);
});

test('mask-free expansion feeds a pre-filled canvas at the exact output size', async () => {
  // 画布 800×600，照片占左侧 600 px，右侧 200 px 是透明区
  const pixels = Buffer.alloc(800 * 600 * 4);
  for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) {
    const i = (y * 800 + x) * 4;
    pixels[i] = 200; pixels[i + 1] = 120; pixels[i + 2] = 60;
    pixels[i + 3] = x < 600 ? 255 : 0;
  }
  const png = await sharp(pixels, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer();
  const { requests, provider } = withFetch({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://example.oss-cn-beijing.aliyuncs.com/b.png' }] } }] } });
  await provider.submit({
    operation: 'expand',
    prompt: '自然延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.3333333333, bottom: 1, left: 1 },
    n: 1,
  });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.parameters.size, '800*600');
  // 送进去的必须是一张铺满目标画布、且不含透明像素的图（透明区转 JPEG 会变白条）
  const sent = Buffer.from(body.input.messages[0].content[0].image.split(',')[1], 'base64');
  const raw = await sharp(sent).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, 800);
  assert.equal(raw.info.height, 600);
  assert.equal(raw.data[(300 * 800 + 700) * 4 + 3], 255);
  assert.match(body.input.messages[0].content[1].text, /自然延伸/);
});

test('masked edit sends a strictly black-and-white cloud mask', async () => {
  const gray = await sharp(Buffer.from([0, 80, 128, 255]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer();
  const mask = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + gray.toString('base64') };
  const { requests, provider } = withFetch({ output: { task_id: 'task-2', task_status: 'PENDING' } });
  await provider.submit({ operation: 'editMasked', prompt: '补全背景', image, mask, n: 1 });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.input.function, 'description_edit_with_mask');
  const sent = Buffer.from(body.input.mask_image_url.split(',')[1], 'base64');
  assert.deepEqual([...await sharp(sent).greyscale().raw().toBuffer()], [0, 0, 255, 255]);
});

test('manual transparent-border expansion crops the core and infers right scale', async () => {
  const pixels = Buffer.alloc(800 * 600 * 4);
  for (let y = 0; y < 600; y++) for (let x = 0; x < 600; x++) pixels[(y * 800 + x) * 4 + 3] = 255;
  const png = await sharp(pixels, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer();
  const selected = Buffer.alloc(800 * 600);
  for (let y = 0; y < 600; y++) selected.fill(255, y * 800 + 600, y * 800 + 800);
  const maskPng = await sharp(selected, { raw: { width: 800, height: 600, channels: 1 } }).png().toBuffer();
  const { requests, provider } = withFetch({ output: { task_id: 'task-3', task_status: 'PENDING' } });
  await provider.submit({ operation: 'expand', prompt: '自然延伸', image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }, mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + maskPng.toString('base64') }, n: 1 });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.input.function, 'expand');
  assert.equal(body.parameters.right_scale, 1 + 200 / 600);
  assert.equal((await sharp(Buffer.from(body.input.base_image_url.split(',')[1], 'base64')).metadata()).width, 600);
});

test('text-to-image uses the Wan 2.7 image-generation endpoint and messages format', async () => {
  const { requests, provider } = withFetch({ output: { task_id: 'task-4', task_status: 'PENDING' } });
  await provider.submit({ operation: 'generate', prompt: '一只白色花瓶', size: '1024*1024', n: 2, seed: 42 });
  assert.match(requests[0].url, /image-generation\/generation$/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'wan2.7-image');
  assert.deepEqual(body.input.messages, [{ role: 'user', content: [{ text: '一只白色花瓶' }] }]);
  assert.equal(body.parameters.size, '1024*1024');
  assert.equal(body.parameters.n, 2);
  assert.equal(body.parameters.seed, 42);
});

test('poll understands both result shapes and provider errors never reveal the API key', async () => {
  const edit = withFetch({ output: { task_id: 'task-5', task_status: 'SUCCEEDED', results: [{ url: 'https://example.oss-cn-beijing.aliyuncs.com/one.png' }] } });
  assert.deepEqual((await edit.provider.poll('task-5')).resultUrls, ['https://example.oss-cn-beijing.aliyuncs.com/one.png']);
  const generation = withFetch({ output: { task_id: 'task-6', task_status: 'SUCCEEDED', choices: [{ message: { content: [{ type: 'image', image: 'https://example.oss-cn-beijing.aliyuncs.com/two.png' }] } }] } });
  assert.deepEqual((await generation.provider.poll('task-6')).resultUrls, ['https://example.oss-cn-beijing.aliyuncs.com/two.png']);
  const failed = withFetch({ code: 'InvalidApiKey', message: 'secret-test-key is invalid' }, 401);
  await assert.rejects(failed.provider.submit({ operation: 'generate', prompt: '花瓶', size: '1024*1024', n: 1 }), (error) => error.code === 'ALIYUN_REQUEST_FAILED' && !error.message.includes('secret-test-key'));
});

test('download normalizes a JPEG cloud result to PNG for both Photoshop hosts', async () => {
  const jpeg = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#345678' } }).jpeg().toBuffer();
  const fetchImpl = async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key' });
  const png = await provider.download('https://example.oss-cn-beijing.aliyuncs.com/result.jpg');
  assert.equal((await sharp(png).metadata()).format, 'png');
});

test('oversized canvas expands through a seam window instead of a downscaled full canvas', async () => {
  // 画布 2560×2560（6.5M 像素，超过 2048×2048 上限），照片占左侧 2048，右侧 512 是透明区。
  // 旧逻辑会把整张压到 2048 见方再放大回来，扩展区天生糊一档；新逻辑只送接缝窗口。
  const pixels = Buffer.alloc(2560 * 2560 * 4);
  for (let y = 0; y < 2560; y++) for (let x = 0; x < 2560; x++) {
    const i = (y * 2560 + x) * 4;
    pixels[i] = 210; pixels[i + 1] = 190; pixels[i + 2] = 170;
    pixels[i + 3] = x < 2048 ? 255 : 0;
  }
  const png = await sharp(pixels, { raw: { width: 2560, height: 2560, channels: 4 } }).png().toBuffer();
  const shot = await sharp({ create: { width: 993, height: 2560, channels: 3, background: '#c8b49a' } }).png().toBuffer();
  const url = 'https://example.oss-cn-beijing.aliyuncs.com/window.png';
  const requests = [];
  const fetchImpl = async (target, init = {}) => {
    if (String(target).endsWith('/image2image/out-painting')) {
      return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'Model not exist.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    requests.push({ target, init });
    if (String(target).endsWith('window.png')) return new Response(shot, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ type: 'image', image: url }] } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '自然延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.25, bottom: 1, left: 1 },
    n: 1
  });
  const body = JSON.parse(requests[0].init.body);
  const [winW, winH] = body.parameters.size.split('*').map(Number);
  // 送进去的是窗口，不是整张画布，而且窗口没超过模型上限
  assert.ok(winW < 2560);
  assert.equal(winH, 2560);
  assert.ok(winW * winH <= 2048 * 2048);
  // 窗口里必须包含原照片的一截作上下文（接缝在 2048，窗口左边界应明显小于它）
  assert.ok(winW >= 512 + 160);

  const out = await provider.download(url);
  const raw = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // 合成回画布尺寸；原照片区透明（不覆盖原图），新增条带有像素
  assert.equal(raw.info.width, 2560);
  assert.equal(raw.info.height, 2560);
  const alphaAt = (x, y) => raw.data[(y * 2560 + x) * 4 + 3];
  assert.equal(alphaAt(100, 100), 0);
  assert.equal(alphaAt(2047, 100), 255);
  assert.equal(alphaAt(2400, 100), 255);
});

test('a stalled cloud request is aborted within the configured request deadline', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  // AbortSignal.timeout() 的定时器是 unref 的：进程里没有别的活时，事件循环会先空掉，
  // 10 毫秒的定时器根本没机会触发，测试就变成在测调度运气（报「event loop 已结束」）。
  // 挂一个短间隔的 keep-alive，让事件循环活到超时真正发生。
  const keepAlive = setInterval(() => {}, 5);
  try {
    const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key', requestTimeoutMs: 10 });
    await assert.rejects(provider.poll('task-1'), { code: 'ALIYUN_NETWORK' });
  } finally {
    clearInterval(keepAlive);
  }
});


test('双向扩图退回整画布路径时仍然只取新增条带，模型重绘整幅也不会顶掉原照片', async () => {
  // 画布 2560×2880，照片 2048×2560 贴左上，右 + 下都扩。
  // 两条条带的并集就是整幅画布，planExpandWindow 必然判空（窗口省不下面积），
  // 于是退回「整画布 + 指令式模型」这条路——指令式模型会把整幅重画一遍。
  // 关键契约：download 之后照片区必须透明，否则 CEP 那边会把重绘结果当扩图贴上去。
  const W = 2560; const H = 2880;
  const pixels = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    pixels[i] = 210; pixels[i + 1] = 190; pixels[i + 2] = 170;
    pixels[i + 3] = x < 2048 && y < 2560 ? 255 : 0;
  }
  const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();

  const requests = [];
  let modelSize = null;
  const url = 'https://example.oss-cn-beijing.aliyuncs.com/repainted.png';
  const fetchImpl = async (target, init = {}) => {
    if (String(target).endsWith('/image2image/out-painting')) {
      return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'Model not exist.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    requests.push({ target, init });
    if (String(target).endsWith('repainted.png')) {
      // 模型「重画了整幅」：整块换成一个完全不同的颜色
      const [w, h] = modelSize.split('*').map(Number);
      const shot = await sharp({ create: { width: w, height: h, channels: 3, background: '#20c020' } }).png().toBuffer();
      return new Response(shot, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    const body = JSON.parse(init.body);
    modelSize = body.parameters.size;
    return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ type: 'image', image: url }] } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key' });
  await provider.submit({
    operation: 'expand',
    prompt: '自然延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.25, bottom: 1.125, left: 1 },
    n: 1
  });
  // 双向确实走了整画布（降采样）路径，没有窗口
  const [apiW, apiH] = modelSize.split('*').map(Number);
  assert.ok(apiW * apiH <= 2048 * 2048, '整画布路径必须压到模型上限以内');

  const out = await provider.download(url);
  const raw = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, W);
  assert.equal(raw.info.height, H);
  const alphaAt = (x, y) => raw.data[(y * W + x) * 4 + 3];
  const rgbAt = (x, y) => { const i = (y * W + x) * 4; return [raw.data[i], raw.data[i + 1], raw.data[i + 2]]; };
  // 照片区：透明（模型画的绿一像素都不能漏出去）
  assert.equal(alphaAt(100, 100), 0);
  // 注意别取 2047/2559 这两个边：条带为了盖住接缝会向内重叠 1 像素
  assert.equal(alphaAt(2040, 2555), 0);
  // 新增条带：有像素
  assert.equal(alphaAt(2400, 100), 255);
  assert.equal(alphaAt(100, 2800), 255);
  // 而且贴上去的确实是模型给的内容（绿色系），说明条带来自回图而不是原照片
  const [r, g] = rgbAt(2400, 100);
  assert.ok(g > r, '条带内容应来自模型回图');
});

// ── 参数化扩图（image-out-painting）─────────────────────────────────────────
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// 512×704 画布：上半 512×640 是照片，底部 64px 透明。
async function expandFixture() {
  const W = 512;
  const H = 704;
  const photoH = 640;
  const pixels = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      pixels[i] = 130;
      pixels[i + 1] = 108;
      pixels[i + 2] = 86;
      pixels[i + 3] = y < photoH ? 255 : 0;
    }
  }
  const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return { W, H, photoH, png };
}

test('扩图优先走参数化接口：四边偏移按几何算，整张画布只回新增条带', async () => {
  const { W, H, photoH, png } = await expandFixture();
  const resultPng = await sharp({
    create: { width: W, height: H, channels: 3, background: '#6e5a46' }
  }).png().toBuffer();
  const requests = [];
  const fetchImpl = async (target, init = {}) => {
    const url = String(target);
    requests.push({ url, init });
    if (url.endsWith('/image2image/out-painting')) {
      return jsonResponse({ output: { task_id: 'task-outpaint-1', task_status: 'PENDING' } });
    }
    if (url.includes('/api/v1/tasks/')) {
      return jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://example.oss-cn-beijing.aliyuncs.com/op.png' }] } });
    }
    return new Response(resultPng, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key' });

  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '自然延伸桌面',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: W, bottom: photoH },
    scales: { top: 1, right: 1, bottom: 1.1, left: 1 },
    n: 1
  });

  assert.match(requests[0].url, /image2image\/out-painting$/);
  assert.equal(requests[0].init.headers['X-DashScope-Async'], 'enable');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'image-out-painting');
  // 只有底边要加 64px，其它三边必须是 0——几何是算出来的，不是模型猜的。
  assert.deepEqual(body.parameters.left_offset, 0);
  assert.deepEqual(body.parameters.top_offset, 0);
  assert.deepEqual(body.parameters.right_offset, 0);
  assert.deepEqual(body.parameters.bottom_offset, H - photoH);
  assert.equal(body.parameters.limit_image_size, false);
  // 送进去的是纯照片（不含透明区），否则 offsets 的基准就错了。
  const sent = Buffer.from(body.input.image_url.split(',')[1], 'base64');
  const sentMeta = await sharp(sent).metadata();
  assert.equal(sentMeta.width, W);
  assert.equal(sentMeta.height, photoH);

  // 模型回的是整张画布，但贴回给 Photoshop 的只能是新增条带。
  const polled = await provider.poll(submitted.taskId);
  assert.equal(polled.status, 'SUCCEEDED');
  const out = await provider.download(polled.resultUrls[0]);
  const raw = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, W);
  assert.equal(raw.info.height, H);
  const alphaAt = (x, y) => raw.data[(y * W + x) * 4 + 3];
  assert.equal(alphaAt(100, 100), 0, '照片区必须保持透明，不能被模型回图顶掉');
  assert.equal(alphaAt(100, H - 20), 255, '新增条带必须有像素');
});

test('业务空间没有该模型时只探测一次，之后直接走指令式', async () => {
  const { W, photoH, png } = await expandFixture();
  let outpaintCalls = 0;
  const fetchImpl = async (target, init = {}) => {
    const url = String(target);
    if (url.endsWith('/image2image/out-painting')) {
      outpaintCalls += 1;
      return jsonResponse({ code: 'InvalidParameter', message: 'Model not exist.' }, 404);
    }
    return jsonResponse({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://example.oss-cn-beijing.aliyuncs.com/m.png' }] } }] } });
  };
  const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key' });
  const job = {
    operation: 'expand',
    prompt: '自然延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: W, bottom: photoH },
    scales: { top: 1, right: 1, bottom: 1.1, left: 1 },
    n: 1
  };
  const first = await provider.submit(job);
  assert.equal((await provider.poll(first.taskId)).status, 'SUCCEEDED', '应当退回指令式并成功');
  await provider.submit(job);
  assert.equal(outpaintCalls, 1, '模型缺失的结论要记住，不该每单都白打一次请求');
});

test('画布超出参数化接口的单边上限时不硬走，直接交给指令式', async () => {
  // 5000px 宽超出 out-painting 的 4096 上限；这条路径必须让位，而不是把它压小。
  const W = 5000;
  const H = 600;
  const pixels = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    pixels[i] = 120; pixels[i + 1] = 110; pixels[i + 2] = 100;
    pixels[i + 3] = x < 4600 ? 255 : 0;
  }
  const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const requests = [];
  const fetchImpl = async (target, init = {}) => {
    const url = String(target);
    requests.push({ url, init });
    return jsonResponse({ output: { choices: [{ message: { content: [{ type: 'image', image: 'https://example.oss-cn-beijing.aliyuncs.com/n.png' }] } }] } });
  };
  const provider = createAliyunProvider({ fetchImpl, endpoint, apiKey: 'test-key' });
  await provider.submit({
    operation: 'expand',
    prompt: '向右延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 4600, bottom: H },
    scales: { top: 1, right: 1.087, bottom: 1, left: 1 },
    n: 1
  });
  assert.equal(requests.some((r) => r.url.endsWith('/image2image/out-painting')), false);
  assert.match(requests[0].url, /multimodal-generation\/generation$/);
});
