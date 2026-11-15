const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createOpenAiCompatProvider, normalizeBaseUrl, aspectForCanvas, aspectBox } = require('../src/providers/openai-compat');

// 假响应必须模拟「模型守规矩」的形态：照片原样返回、只有延伸区被重画。
// 以前这里统一回一张纯色整图，等于每次都在模拟「模型把整张画面重画一遍」——
// 新增的 alien 判据（照片区漂移 > 10 灰阶）会把这类响应全部拦下，测试就全红了。
//
// noMaskRightFrom：不带遮罩的请求（padded / bare 形态）没有 mask 可循，
// 传一个 0~1 的横向比例，就从那里到右边整块重画——模拟「模型看懂了文字说明」。
async function paintBand(form, noMaskRightFrom = null) {
  const image = Buffer.from(await form.get('image').arrayBuffer());
  const maskField = form.get('mask');
  if (!maskField && noMaskRightFrom === null) return image;
  const base = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = base.info.width;
  const H = base.info.height;
  const C = base.info.channels;
  let mask = null;
  if (maskField) mask = await sharp(Buffer.from(await maskField.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(base.data);
  const paint = (x, y) => {
    const i = (y * W + x) * C;
    out[i] = 90 + ((x * 7 + y * 3) % 110);
    out[i + 1] = 80 + ((x * 3 + y * 5) % 100);
    out[i + 2] = 70 + ((x * 5 + y * 7) % 90);
    if (C === 4) out[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask) {
        const mi = (y * mask.info.width + x) * 4 + 3;
        if (mask.data[mi] >= 128) continue; // 不透明 = 保留原样
      } else if (x < W * noMaskRightFrom) {
        continue;
      }
      paint(x, y);
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
}


// 这些测试锁住「第三方 OpenAI 兼容渠道」最容易出错的三件事：
// 1) 地址归一化（很多中转的基址带不带 /v1 都有人写）
// 2) 扩图的遮罩语义（OpenAI 是「透明=要改」，跟我们本地的白色选区正好相反）
// 3) 尺寸降级链（不知道对方支持什么尺寸时，要能自己试出来）

test('base url normalization keeps an existing version prefix and adds a missing one', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/v1');
  assert.throws(() => normalizeBaseUrl('ftp://x'), /接口地址/);
});

test('mask-free expansion sends a mask whose transparent band covers exactly the new area', async () => {
  const width = 1024;
  const height = 768;
  const photoRight = 640;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 160; pixels[i + 1] = 140; pixels[i + 2] = 120;
      pixels[i + 3] = x < photoRight ? 255 : 0;
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const shot = await sharp({ create: { width, height, channels: 3, background: '#887766' } }).png().toBuffer();

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const painted = await paintBand(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '向右延伸桌面',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.6, bottom: 1, left: 1 },
    n: 1
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/images/edits');
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData, 'edits 必须走 multipart');
  assert.equal(form.get('size'), '1024x768');

  const maskBytes = Buffer.from(await form.get('mask').arrayBuffer());
  const mask = await sharp(maskBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => mask.data[(y * mask.info.width + x) * 4 + 3];
  // 照片区不透明 = 保留原样；新增区透明 = 交给模型重绘。
  assert.equal(alphaAt(100, 100), 255);
  assert.equal(alphaAt(photoRight - 2, 100), 255);
  assert.equal(alphaAt(photoRight + 10, 100), 0);
  assert.equal(alphaAt(1020, 700), 0);

  const poll = provider.poll(submitted.taskId);
  assert.equal(poll.status, 'SUCCEEDED');
  const result = await provider.download(poll.resultUrls[0]);
  const composed = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(composed.info.width, width);
  assert.equal(composed.info.height, height);
  const resultAlphaAt = (x, y) => composed.data[(y * width + x) * 4 + 3];
  // 回来的图只有新增条带有像素，原照片区必须透明，否则 CEP 侧会盖掉原图。
  assert.equal(resultAlphaAt(100, 100), 0);
  assert.equal(resultAlphaAt(1000, 100), 255);
});

test('an unsupported size falls through to the next candidate instead of failing the job', async () => {
  const width = 704;
  const height = 512;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 180; pixels[i + 1] = 160; pixels[i + 2] = 140;
      pixels[i + 3] = x < 500 ? 255 : 0;
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const shot = await sharp({ create: { width, height, channels: 3, background: '#908070' } }).png().toBuffer();

  const sizes = [];
  const fetchImpl = async (url, init = {}) => {
    const size = init.body.get('size');
    sizes.push(size);
    if (size === '704x512') {
      return new Response(JSON.stringify({ error: { message: 'invalid size: 704x512 is not supported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const painted = await paintBand(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com', apiKey: 'k', model: 'gpt-image-1' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.4, bottom: 1, left: 1 },
    n: 1
  });
  // 第一次用精确尺寸被拒，第二次不带 size（交给服务端自适应）
  assert.deepEqual(sizes, ['704x512', null]);
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

test('results returned as a url are downloaded and normalized to the canvas size', async () => {
  const width = 640;
  const height = 640;
  const pixels = Buffer.alloc(width * height * 4, 128);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(y * width + x) * 4 + 3] = x < 480 ? 255 : 0;
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const odd = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#aaaaaa' } }).png().toBuffer();

  const fetchImpl = async (url) => {
    if (String(url).includes('/images/edits')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/out.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(odd, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1' });
  const submitted = await provider.submit({
    operation: 'editWhole',
    prompt: '整图重绘',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    n: 1
  });
  const result = await provider.download(provider.poll(submitted.taskId).resultUrls[0]);
  const meta = await sharp(result).metadata();
  // 服务端只给了 512，插件必须缩回画布尺寸，否则 CEP 侧尺寸校验会失败。
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
});

test('a request that runs past its deadline reports a timeout instead of a network failure', async () => {
  // 真实场景：中转站同步出图，2600×2560 的图要两三分钟。以前 120 秒就掐，
  // 报「无法连接图像接口」，用户去查网络、换地址，怎么查都是好的。
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  const provider = createOpenAiCompatProvider({
    fetchImpl: async () => { throw timeout; },
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1',
    requestTimeoutMs: 5000
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.match(error.message, /超时/);
      return true;
    }
  );
});

test('a real connection failure still reports a network error', async () => {
  const provider = createOpenAiCompatProvider({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1'
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 }),
    (error) => error.code === 'PROVIDER_NETWORK'
  );
});

test('a temporary upstream failure is retried instead of failing the job', async () => {
  // 真实场景：中转站回了 503 "10k pool upstream unavailable"——请求根本没走到模型，
  // 是站方渠道池没容量。这类抖动重发一次就过，不该让用户看到红字。
  const shot = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#224466' } }).png().toBuffer();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: '10k pool upstream unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1',
    upstreamRetryDelayMs: 0,
    poolRetryDelays: [0]
  });
  const submitted = await provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 });
  assert.equal(calls, 2);
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

test('a pool failure that clears on the third try still produces a result', async () => {
  // 用户反馈的原始现象：「有时候能用，有时候不能」。实测同一尺寸连发 4 次全过，
  // 说明这个组合在池子里是有容量的，只是节点时有时无。这种波动不该由用户手动点
  // 「重试」来赌——每点一次都要把几 MB 的底稿重新上传一遍。
  const shot = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#445566' } }).png().toBuffer();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response(JSON.stringify({ error: { message: 'no available channel for model gemini-3.1-flash-image-1104x1536' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gemini-3.1-flash-image',
    upstreamRetryDelayMs: 0,
    poolRetryDelays: [0]
  });
  const submitted = await provider.submit({ operation: 'generate', prompt: '一面白墙', size: '1024*1024', n: 1 });
  assert.equal(calls, 3);
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

test('a generic 500 is still only retried once, so a processed request is not billed twice', async () => {
  // 池子类失败明确「没走到模型」，重发零代价；其他 5xx 可能是请求已经开始处理才报的错，
  // 重发会多出一张图、多扣一次费。两条预算必须分开，不能因为要「多试几次」就一起放大。
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'internal error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1',
    upstreamRetryDelayMs: 0,
    poolRetryDelays: [0]
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 }),
    (error) => error.code === 'PROVIDER_UPSTREAM'
  );
  assert.equal(calls, 2);
});

test('a chinese pool message is retried like the english one', async () => {
  // 真实日志（2026-11-13 09:54）：503 +
  // 「所有分组对于模型 gemini-3.1-flash-image-1104x1536 无可用渠道，请检查模型是否存在
  //   或联系管理员 (request id: EMaster20261113015423…)」
  // 第一版 POOL_TEXT 只认英文措辞，这条于是走进了「其他上游失败」的预算：5 秒就收尾，
  // 自动重试等于没发生。判据不能只靠英文，503 本身就该算「请求没走到模型」。
  let calls = 0;
  const msg = '所有分组对于模型 gemini-3.1-flash-image-1104x1536 无可用渠道，请检查模型是否存在或联系管理员 (request id: EMaster202611130154239622278158268d9d6oN6DJXWC)';
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: msg } }), { status: 503, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gemini-3.1-flash-image',
    upstreamRetryDelayMs: 0,
    poolRetryDelays: [0]
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一面白墙', size: '1104x1536', n: 1 }),
    (error) => {
      assert.match(error.message, /自动重试 3 次/);
      assert.match(error.message, /无可用渠道/);
      // request id 只对站方客服有用，贴在面板里会撑出两行、把有用的半句挤没。
      assert.ok(!/request id/i.test(error.message), '错误文案里不应包含 request id');
      return true;
    }
  );
  assert.equal(calls, 4);
});

test('a persistent upstream outage reports its own code and names the request size', async () => {
  // 一直不可用时要停下来，并且说人话：原文 "10k pool upstream unavailable"
  // 对用户毫无信息量，至少要带上「这次要了多大一张图」才有办法做减法。
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: '10k pool upstream unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1',
    upstreamRetryDelayMs: 0,
    poolRetryDelays: [0]
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UPSTREAM');
      assert.match(error.message, /上游暂时不可用/);
      assert.match(error.message, /1024×1024/);
      // 池子类失败要如实说明「已经替用户试过几轮」，否则用户会以为重试没发生。
      assert.match(error.message, /自动重试 3 次/);
      // 也不能再暗示「尺寸不支持」：实测同一尺寸连发 4 次全过。
      assert.match(error.message, /不是这个尺寸不支持/);
      return true;
    }
  );
  // 1 次首发 + 3 次自动重试。
  assert.equal(calls, 4);
});

test('a rejected size is not retried, because the same request would be rejected again', async () => {
  // 尺寸被拒是确定性错误：重发一模一样的请求只会得到一模一样的拒绝，
  // 还白白多等一轮。它应该立刻进入下一个候选尺寸。
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'size not supported for this model' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1',
    upstreamRetryDelayMs: 0
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 }),
    (error) => {
      // 所有候选都被尺寸拒绝时抛出的是最后一个原始错误，靠 sizeRejected 标记识别。
      assert.equal(error.sizeRejected, true);
      assert.match(error.message, /size not supported/);
      return true;
    }
  );
  // 候选依次是 1024x1024 → auto → 1536x1024，各打一次，没有额外重试。
  assert.equal(calls, 3);
});

test('a photo too large to upload is re-encoded before it reaches the endpoint', async () => {
  // 2672×2560 的照片存成 PNG 有 10MB 以上，很多中转站会在这个体积上直接断连，
  // 报出来却是「无法连接图像接口」——看着像网络问题，实际是被网关拒了。
  // 这里保证送出去的图不会超过 4MB，并且在超限时换成 JPEG。
  const width = 1400;
  const height = 1400;
  const noise = Buffer.alloc(width * height * 3);
  require('node:crypto').randomFillSync(noise);
  const big = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
  assert.ok(big.length > 4 * 1024 * 1024, '样本图应当超过 4MB，否则测不到压缩逻辑');

  const shot = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#334455' } }).png().toBuffer();
  let uploaded = null;
  const fetchImpl = async (url, init = {}) => {
    const file = init.body.get('image');
    uploaded = { size: file.size, type: file.type };
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1' });
  await provider.submit({
    operation: 'editWhole',
    prompt: '换个背景',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + big.toString('base64') },
    n: 1
  });
  assert.ok(uploaded, '应当发出一次 edits 请求');
  assert.ok(uploaded.size <= 4 * 1024 * 1024, `上传体积应被压到 4MB 以内，实际 ${(uploaded.size / 1024 / 1024).toFixed(1)}MB`);
  assert.equal(uploaded.type, 'image/jpeg');
});

test('a size the upstream pool refuses is retried at the safe tier instead of failing', async () => {
  // 实测：某中转的 gpt-image-2.6-flare 在 2048 档返回 503 "10k pool upstream unavailable"，
  // 同一张图降到 1536 就能正常出图。所以「上游不可用」不能一律当成站方宕机，
  // 大尺寸要先降到安全档——否则 2672×2560 的画布永远是红字。
  const png = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#778899' } }).png().toBuffer();
  const shot = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#334455' } }).png().toBuffer();
  const sizes = [];
  const fetchImpl = async (url, init = {}) => {
    const size = init.body.get('size');
    sizes.push(size);
    if (size !== '1536x1536') {
      return new Response(JSON.stringify({ error: { message: '10k pool upstream unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-2.6-flare',
    upstreamRetryDelayMs: 0,
    // 大尺寸被池子拒绝时，先按池子预算重试几轮，再考虑降档。
    // 测试里把退避压成 0，否则这一条要白等二十秒。
    poolRetryDelays: [0]
  });
  const submitted = await provider.submit({
    operation: 'editWhole',
    prompt: '延伸背景',
    n: 1,
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
  });
  assert.equal(submitted.size, '1536x1536');
  assert.ok(sizes.includes('1600x1600'), '应当先按画布尺寸试一次');
});

test('a connection reset on a large request also downshifts, and the ceiling is remembered', async () => {
  // 同一件事的另一种表现：大尺寸请求不总是回 503，有时网关直接把上传连接掐断，
  // undici 报的是 TypeError('fetch failed') + cause.code = ECONNRESET。
  // 之前在面板上看到的红字是「无法连接图像接口（ECONNRESET），请检查地址和网络」——
  // 让用户去查网络，而网络其实是好的。降档成功一次之后，后续任务要直接按安全档发请求，
  // 不再每次都先白等十秒撞一次墙。
  const png = await sharp({ create: { width: 2048, height: 1600, channels: 3, background: '#6b5b4a' } }).png().toBuffer();
  const shot = await sharp({ create: { width: 512, height: 400, channels: 3, background: '#2b2b2b' } }).png().toBuffer();
  const sizes = [];
  const fetchImpl = async (url, init = {}) => {
    const size = init.body.get('size');
    sizes.push(size);
    if (size === '2048x1600') {
      const failure = new TypeError('fetch failed');
      failure.cause = { code: 'ECONNRESET' };
      throw failure;
    }
    const painted = await paintBand(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-reset-1' });
  // 用整图重绘来验证降档链：它会先按画布原尺寸试一次。
  // （扩图现在不走这条路了——扩图直接按渠道上限算出的安全档发请求，见文末的用例。）
  const submitted = await provider.submit({
    operation: 'editWhole',
    prompt: '向右延伸桌面',
    n: 1,
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
  });
  assert.equal(sizes[0], '2048x1600', '应当先按画布尺寸试一次');
  assert.equal(submitted.size, '1536x1200', '连接被重置后应当降到 1536 长边');
  assert.match(submitted.notice, /1536x1200/);

  // 第二次：上限已记住，不该再打 2048x1600。
  sizes.length = 0;
  await provider.submit({
    operation: 'editWhole',
    prompt: '向右延伸桌面',
    n: 1,
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
  });
  assert.equal(sizes[0], '1536x1200', '已知上限后应当直接按安全档发请求');
});

test('a reset that survives the downshift is reported as a channel problem, not a local network one', async () => {
  const png = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#4a5b6b' } }).png().toBuffer();
  const fetchImpl = async () => {
    const failure = new TypeError('fetch failed');
    failure.cause = { code: 'ECONNRESET' };
    throw failure;
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-reset-2' });
  await assert.rejects(
    () => provider.submit({
      operation: 'editWhole',
      prompt: '换个背景',
      n: 1,
      image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_NETWORK');
      assert.match(error.message, /ECONNRESET/);
      assert.match(error.message, /不是本地网络问题/);
      return true;
    }
  );
});

test('text-to-image goes to the generations endpoint with a JSON body', async () => {
  const shot = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#123456' } }).png().toBuffer();
  let seen = null;
  const fetchImpl = async (url, init = {}) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1' });
  const submitted = await provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 2 });
  assert.equal(seen.url, 'https://api.example.com/v1/images/generations');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.prompt, '一只猫');
  assert.equal(body.n, 2);
  assert.ok('size' in body);
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

test('tier mode sends image_size instead of size for gemini-style endpoints', async () => {
  // Gemini / Nano-banana 那一类模型不认 size="3074x2560"，只认 image_size="4K"。
  // 画布 3000×2500 = 7.5M 像素，应当落到 4K 档，而不是被压成 1536。
  const width = 3000;
  const height = 2500;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 150; pixels[i + 1] = 130; pixels[i + 2] = 110;
      pixels[i + 3] = x < 2100 ? 255 : 0;
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  // 配了 aspect_ratio=16:9，模型就该按 16:9 回图。以前这里回的是画布比例
  // （2048×1707），靠「不检查比例」蒙过去；现在检查目标就是 aspect_ratio，
  // 假响应必须照着它出，否则测的就不是这条路径了。
  const shot = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: '#908070' } }).png().toBuffer();

  let form = null;
  const fetchImpl = async (url, init = {}) => {
    form = init.body;
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gemini-3.1-flash-image-preview', sizeMode: 'tier', aspectRatio: '16:9' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.4, bottom: 1, left: 1 },
    n: 1
  });
  assert.equal(form.get('image_size'), '4K');
  assert.equal(form.get('size'), null);
  assert.equal(form.get('aspect_ratio'), '16:9', '档位模式下比例必须一起发，否则渠道按默认比例出图');

  // 模型按 16:9 出了 2048×1152，回来必须缩回画布尺寸，否则裁切会错位
  const result = await provider.download(provider.poll(submitted.taskId).resultUrls[0]);
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
});

test('b64_json wrapped in a data URL is decoded correctly', async () => {
  // 有些中转站（如 comfly 的 seedream / gemini 路由）把 b64_json 写成整条 data URL。
  // 直接 base64 解码会把 "data:image/png;base64," 当成有效输入，产出损坏的图片。
  const width = 640, height = 512;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = 120; pixels[i + 1] = 110; pixels[i + 2] = 100;
    pixels[i + 3] = x < 420 ? 255 : 0;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const shot = await sharp({ create: { width, height, channels: 3, background: '#a09080' } }).png().toBuffer();
  const dataUrl = 'data:image/png;base64,' + shot.toString('base64');

  const provider = createOpenAiCompatProvider({
  fetchImpl: async (url, init = {}) => new Response(JSON.stringify({ data: [{ b64_json: 'data:image/png;base64,' + (await paintBand(init.body)).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'seedream-v5-pro'
  });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.6, bottom: 1, left: 1 },
    n: 1
  });
  const result = await provider.download(provider.poll(submitted.taskId).resultUrls[0]);
  // 能解析成图就是通过——损坏的 base64 会在 sharp 这里直接抛 unsupported image format
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
});

test('photo bounds from Photoshop win over alpha guessing, so expansion strips are not squeezed away', async () => {
  // 复现真实翻车场景：照片边缘有一圈半透明（描边/投影/抗锯齿），整张 alpha 都 > 0。
  // 服务端若靠 alpha 反推，opaqueBounds 会等于整张画布 → 没有条带 → 合成出一张
  // 全透明的图 → CEP 照常裁切合并 → 用户看到「扩图区合并后不见了」。
  const width = 1024, height = 768, photoRight = 640;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = 150; pixels[i + 1] = 130; pixels[i + 2] = 110;
      // 透明区残留极低 alpha，alpha 反推会把它当成照片内容
      pixels[i + 3] = x < photoRight ? 255 : 8;
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const shot = await sharp({ create: { width, height, channels: 3, background: '#887766' } }).png().toBuffer();

  const calls = [];
  const provider = createOpenAiCompatProvider({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const painted = await paintBand(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1'
  });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '向右延伸桌面',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    scales: { top: 1, right: 1.6, bottom: 1, left: 1 },
    canvasBounds: { left: 0, top: 0, right: photoRight, bottom: height },
    n: 1
  });

  assert.equal(calls.length, 1);
  // 遮罩必须按 Photoshop 给的范围算：照片区保留、右侧才重绘
  const mask = await sharp(Buffer.from(await calls[0].init.body.get('mask').arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => mask.data[(y * mask.info.width + x) * 4 + 3];
  assert.equal(alphaAt(100, 100), 255);
  assert.equal(alphaAt(photoRight + 20, 100), 0);

  const result = await provider.download(provider.poll(submitted.taskId).resultUrls[0]);
  const composed = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const resultAlphaAt = (x, y) => composed.data[(y * width + x) * 4 + 3];
  assert.equal(resultAlphaAt(100, 100), 0, '原照片区必须透明，否则会盖掉原图');
  assert.equal(resultAlphaAt(photoRight + 20, 100), 255, '新增条带必须有像素，否则贴回去就是一片透明');
});

test('photos covering the whole canvas fail loudly instead of returning an all-transparent result', async () => {
  const width = 704, height = 512;
  const pixels = Buffer.alloc(width * height * 4, 200);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();

  const provider = createOpenAiCompatProvider({
    fetchImpl: async () => { throw new Error('不该发出请求：范围就已经不成立'); },
    baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1'
  });

  await assert.rejects(
    provider.submit({
      operation: 'expand',
      prompt: '延伸',
      image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
      scales: { top: 1, right: 1.4, bottom: 1, left: 1 },
      canvasBounds: { left: 0, top: 0, right: width, bottom: height },
      n: 1
    }),
    (error) => error.code === 'NO_EXPAND_AREA'
  );
});

// 结果图放在另一个图床域名上，它和接口是否可达是两件事。实测同一分钟内连 8 次，
// 会有 1 次 ECONNRESET——链路抖动是常态。一次失败就放弃的代价特别高：
// 图已经出出来、钱已经花了、还等了四五分钟，却因为最后一步下载被掐全部作废。
function resetError(code = 'ECONNRESET') {
  const error = new TypeError('fetch failed');
  error.cause = { code };
  return error;
}

async function urlResultProvider(downloadFactory, options = {}) {
  // 必须是一张「真」能解码、且大于 1KB 的图：collectImages 会把 <1KB 的响应当成空图。
  const raw = Buffer.alloc(160 * 160 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 1103515245 + 12345) >> 16 & 0xff;
  const png = options.png || await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } }).png().toBuffer();
  const downloads = [];
  const fetchImpl = async (url) => {
    if (String(url).includes('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/out.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    downloads.push(String(url));
    return downloadFactory(downloads.length, png);
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'gpt-image-1',
    downloadRetryDelayMs: 1,
    ...options.providerOptions
  });
  const submit = () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024x1024', n: 1 });
  return { provider, submit, downloads };
}

test('a reset while downloading the result is retried instead of throwing the image away', async () => {
  const { submit, downloads } = await urlResultProvider((attempt, png) => {
    if (attempt < 3) throw resetError();
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  const submitted = await submit();
  assert.equal(submitted.resultUrls.length, 1);
  assert.equal(downloads.length, 3, '前两次被重置，第三次才拿到图');
});

test('download gives up only after every attempt is exhausted, and says how many', async () => {
  const { submit } = await urlResultProvider(() => { throw resetError(); });
  await assert.rejects(submit(), (error) => {
    assert.equal(error.code, 'RESULT_DOWNLOAD');
    assert.match(error.message, /ECONNRESET/);
    assert.match(error.message, /已重试 \d+ 次/);
    // 这句话是给用户吃定心丸的：图还在，重试不会再花一次钱。
    assert.match(error.message, /不会重新生成/);
    return true;
  });
});

test('an expired result link is not retried: a 403 will not become a 200', async () => {
  const { submit, downloads } = await urlResultProvider(() => new Response('gone', { status: 403 }));
  await assert.rejects(submit(), (error) => {
    assert.equal(error.code, 'RESULT_DOWNLOAD');
    assert.match(error.message, /已过期/);
    return true;
  });
  assert.equal(downloads.length, 1, '确定性的拒绝不该浪费五次请求');
});

test('a reset on the api call itself is retried once before giving up', async () => {
  const raw = Buffer.alloc(160 * 160 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 1103515245 + 12345) >> 16 & 0xff;
  const png = await sharp(raw, { raw: { width: 160, height: 160, channels: 3 } }).png().toBuffer();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw resetError();
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1', upstreamRetryDelayMs: 1
  });
  const submitted = await provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024x1024', n: 1 });
  assert.equal(calls, 2);
  assert.equal(submitted.resultUrls.length, 1);
});

// ── 「模型把底稿原样交回来」──────────────────────────────────────────────
// 真实翻车记录：2618×2560 的画布向右扩 570px，请求成功、合成成功、落位成功，
// 但扩展区其实是上传时那张模糊底稿原封不动地被交了回来，用户在 PS 里看到右边
// 接了一块白雾，就是「生成内容不符」。请求层面完全看不出问题，只能比像素。

async function expandCanvas(width = 1024, height = 768, photoRight = 640) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // 给原图一些细节（渐变 + 条纹），这样底稿的扩展区和纯色能区分开
      pixels[i] = (x * 3) % 200;
      pixels[i + 1] = (y * 2) % 180;
      pixels[i + 2] = 120;
      pixels[i + 3] = x < photoRight ? 255 : 0;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test('模型原样返回底稿时会换请求形态重试，三种都不行才报 EXPAND_FLAT', async () => {
  const png = await expandCanvas();
  const prompts = [];
  const shapes = [];
  const fetchImpl = async (url, init = {}) => {
    const form = init.body;
    prompts.push(form.get('prompt'));
    shapes.push(form.get('mask') ? 'masked' : 'plain');
    const uploaded = Buffer.from(await form.get('image').arrayBuffer());
    return new Response(JSON.stringify({ data: [{ b64_json: uploaded.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  await assert.rejects(
    () => provider.submit({
      operation: 'expand',
      prompt: '',
      image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
      canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
      n: 1
    }),
    (error) => {
      assert.equal(error.code, 'EXPAND_FLAT');
      assert.match(error.message, /画面描述/, '报错要说清下一步能做什么');
      return true;
    }
  );
  assert.equal(prompts.length, 3, '应当三种请求形态都试过再放弃');
  // 形态必须真的不同：同一句话改三遍没有意义，模型不听话时是同一个错法。
  assert.deepEqual(shapes, ['masked', 'plain', 'plain']);
  assert.match(prompts[1], /上一版/, '第二次要指出上一版的问题');
  assert.match(prompts[0], /严禁把延伸区涂成一片纯色/, '第一次就要带上硬约束');
});

test('重试后真的画了内容就正常出图，不再报错', async () => {
  const png = await expandCanvas();
  // 第二版必须是「守规矩且有细节」的图：纯色会被细节判据拦成「糊成一片」，
  // 整张重画会被 alien 判据拦成「自己重新构图」，这条用例要验证的是「画了就该放行」。
  // 第二次走的是不带遮罩的形态，所以按画布几何把右边那块重画——这正是现实中
  // 「遮罩被中转站吞掉、但模型看懂了文字说明」的样子。
  let calls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls += 1;
    const shot = calls === 1
      ? Buffer.from(await init.body.get('image').arrayBuffer()) // 第一次：原样交回
      : await paintBand(init.body, 0.62);                        // 第二次：只重画延伸区
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '右边接着白墙',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
    n: 1
  });
  assert.equal(calls, 2);
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

// ── 「画了，但接不上」不该等于「什么都没有」─────────────────────────────
// 真实翻车记录：三次扩图，三次都报错退出，PS 里右边始终是空的棋盘格。
// 模型确实每次都画了东西，只是画得不理想（整张重画 / 糊成一片）。把它连人带图
// 一起扔掉，用户花了钱、等了两分钟，得到的只是一段红字。
// 正确的行为是：挑一个最像样的交出去，并在提示里说清哪里不对。
async function repaintScene(w, h) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      data[i] = 200 - ((x * 5) % 60);
      data[i + 1] = 170 - ((y * 7) % 50);
      data[i + 2] = 140;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('模型把整张画面重画时不空手而归：照常出图，并在提示里说清毛病', async () => {
  const png = await expandCanvas();
  const shot = await repaintScene(1024, 768);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '右边延续暖色的室内',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
    n: 1
  });
  assert.equal(calls, 3, '三种请求形态都会试过');
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED', '有内容就必须出图');
  assert.match(submitted.notice, /重新画了一遍/, '要在面板上说清为什么接不上');
  const { data, info } = await sharp(provider.download(submitted.resultUrls[0])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1024);
  assert.equal(info.height, 768);
  // 照片区仍然是透明的——CEP 侧靠这个把结果裁出来；原照片永远不参与合成。
  assert.equal(data[(400 * 1024 + 300) * 4 + 3], 0, '照片区不能有像素');
  assert.equal(data[(400 * 1024 + 900) * 4 + 3], 255, '延伸区必须有像素');
});

// ── 尺寸档位的宽高比是固定的，扩图不能靠它 ─────────────────────────────
// 这是连续四次「接不上」的真正根因，日志里一眼能看出来：
//   走 size=1536x1504 的两次 → 模型返回 1536x1504，比例偏差 0.1%，正常出图
//   走 size=4K 的每一次     → 模型返回 3018x2084 / 3072x2048，比例偏差 37~42%
// comfly 的 4K 档一律回 3:2，而画布是 2738×2560（1.07）。模型不是"补右边"，
// 是在一张宽高比完全不同的画布上重新构图——drift 47~54 灰阶，整张重画。
// 几何前提就已经错了，提示词写得再好也没用。

test('档位渠道扩图走档位，并按画布比例自动带上 aspect_ratio', async () => {
  // 这条用例以前断言的正好相反：「第一次必须是像素尺寸，不能是档位」。
  //
  // 那个结论是在 comfly 的 gpt-image 4K 档下得出的——它固定回 3:2，画布 2738×2560
  // 拿到 3018×2084，偏 38%，模型只能整张重画。但换成 Gemini 之后实测完全是另一回事：
  //   给 aspect_ratio=3:2 → 回 1264×848（偏 0.6%）
  //   给 size=2600x2560   → 回 1024×1024（被压成默认档，放大 2.5 倍，糊）
  //   给 image_size=4K + 1:1 → 回 4096×4096（对 2600 画布是**缩小**）
  // 也就是说档位不但能用，还是唯一能拿到高分辨率的路径。前提是把比例一起发。
  const png = await expandCanvas();
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({
      size: init.body.get('size') || init.body.get('image_size'),
      aspect: init.body.get('aspect_ratio')
    });
    const shot = await paintBand(init.body, 0.62);
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // 配了档位、没配 aspect_ratio —— 以前就是这套配置出事，现在比例由画布推导
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gemini-3.1-flash-image', sizeMode: 'tier' });
  await provider.submit({
    operation: 'expand',
    prompt: '延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
    n: 1
  });
  assert.ok(['1K', '2K', '4K'].includes(seen[0].size), '档位渠道该用档位，不是像素尺寸');
  assert.equal(seen[0].aspect, '4:3', '1024×768 的画布应当自动推导出 4:3，不能空着让渠道按默认比例出图');
  assert.equal(seen[0].size, '1K', '这个画布只有 0.8MP，1K 档就够，不用上 4K');
});

test('档位返回的图跟画布比例差太多时，不交付而是换一个尺寸重来', async () => {
  // 比例差 38% 的图，合成时会被拉伸填满画布，接缝错位上千像素。
  // 这种图内容画得再好也不可能接上，判它"画得不对"是误诊——该换尺寸。
  const png = await expandCanvas();
  let calls = 0;
  const sizes = [];
  const fetchImpl = async (url, init = {}) => {
    calls += 1;
    sizes.push(init.body.get('size') || init.body.get('image_size'));
    const band = await paintBand(init.body, 0.62);
    const shot = calls === 1
      // 第一次故意回一张 3:2 的图（模拟 4K 档固定比例）
      ? await sharp(band).resize(1024, 640, { fit: 'fill' }).png().toBuffer()
      : band;
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '延伸',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
    n: 1
  });
  assert.equal(calls, 2, '比例不对的那次不该被当成"内容画错"去重试三次');
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
  assert.notEqual(sizes[0], sizes[1], '要换一个尺寸，而不是拿同一档再问一遍');
});

test('大画布扩图直接按渠道上限发请求，不先撞一次必然失败的原尺寸', async () => {
  // 2738×2560、2528×2560 这种画布要「原尺寸」等于白等十几秒再被上游拒。
  // 按比例算出的安全档（长边 1536）一次就能出图，且比例偏差只有 0.3%。
  const png = await sharp({ create: { width: 2048, height: 1600, channels: 3, background: '#6b5b4a' } }).png().toBuffer();
  const sizes = [];
  const fetchImpl = async (url, init = {}) => {
    sizes.push(init.body.get('size') || init.body.get('image_size'));
    const painted = await paintBand(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-small-1' });
  await provider.submit({
    operation: 'expand',
    prompt: '延伸',
    n: 1,
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 1600, bottom: 1600 }
  });
  assert.equal(sizes[0], '1536x1200', '第一次就该是安全档，比例与画布一致（1.28）');
});

// ── ECONNREFUSED 不是「地址写错」，是「这一瞬间连不出去」────────────────
// 真实翻车：11:02 那次扩图，日志是「连接被重置 → 重试 1 次 → ECONNREFUSED → 判失败」。
// 同一条链路几分钟后连测 5 次，全部返回 401（通的）。也就是说这次失败纯粹是抖动，
// 而代码把它当成了配置错误——用户等了两分钟、烧了一次额度，什么都没拿到。
const refuse = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 67.21.77.171:443'), { code: 'ECONNREFUSED' })
});

test('连接被拒时按退避多试几次，抖动过去就正常出图', async () => {
  const shot = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#335577' } }).png().toBuffer();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) throw refuse();       // 前两次连不上
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({
    fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1',
    connectRetryDelayMs: 0
  });
  const submitted = await provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 });
  assert.equal(calls, 3, '连不上要重试两次（共三次尝试）');
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED', '抖动过去就该出图');
});

test('一直连不上时说清是「连不上」而不是「地址写错」', async () => {
  let calls = 0;
  const provider = createOpenAiCompatProvider({
    fetchImpl: async () => { calls += 1; throw refuse(); },
    baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-1',
    connectRetryDelayMs: 0
  });
  await assert.rejects(
    () => provider.submit({ operation: 'generate', prompt: '一只猫', size: '1024*1024', n: 1 }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_NETWORK');
      assert.equal(error.connect, true, '要标出来这是连不上，上层据此给不同建议');
      assert.match(error.message, /连不上图像接口/);
      assert.match(error.message, /不是插件也不是模型/, '别让人以为是插件坏了');
      assert.match(error.message, /重试 2 次/);
      return true;
    }
  );
  assert.equal(calls, 3, '连不上总共试三次才放弃');
});

// ── 底稿尺寸必须和请求尺寸一致，否则模型只能整张重画 ────────────────────
// 11 月 12 日那次的真实链路：
//   要 1536x1520 → 回 2834x2220（偏 23%）→ 弃用
//   要 2608x2560 → 回 3132x2010（偏 43%）→ 弃用
//   要 auto      → 回 3094x2034（偏 40%）→ 弃用
//   要 1024x1024 → 回 1024x1024 ✅ 但只剩 2.5 倍放大可用，用户看到「内容对不上」
// 三个问题叠在一起：渠道会把不认识的尺寸换掉；我们却始终按 1536 长边做底稿，
// 传上去的图比请求尺寸小；而且被改写后还要把剩下的候选挨个撞一遍。
test('渠道改写尺寸时改用比例对得上的标准档，且底稿尺寸与请求一致', async () => {
  const png = await expandCanvas(2000, 2000, 1200);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const form = init.body;
    const size = form.get('size') || form.get('image_size');
    const uploaded = Buffer.from(await form.get('image').arrayBuffer());
    const meta = await sharp(uploaded).metadata();
    calls.push({ size, dims: meta.width + 'x' + meta.height });
    if (calls.length === 1) {
      // 模拟中转站「不认识这个尺寸」：按自己的比例回一张
      const shot = await sharp({ create: { width: 1024, height: 768, channels: 3, background: '#6b6055' } }).png().toBuffer();
      return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const painted = await paintBand(form);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // 用独立模型名：sizeRewrites 是按 「baseUrl|model」 记的进程级状态，
  // 前面的用例已经把这个渠道标成「会改写尺寸」了，共用名字就测不到「第一次踩到」的路径。
  //
  // 这里刻意用**像素模式**：这条路径测的是「发具体像素尺寸、被渠道换掉」的补救。
  // 档位模式下请求里根本没有像素尺寸，比例由 aspect_ratio 保证，是另一条路
  // （见「档位渠道扩图走档位」那条）。
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-bucket-test' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 1200, bottom: 2000 },
    n: 1
  });

  assert.equal(calls[0].dims, calls[0].size, '底稿必须按请求尺寸来做');
  assert.equal(calls[1].size, '1024x1024', '比例被改写后应改用最接近画布的标准档');
  assert.equal(calls[1].dims, '1024x1024', '换档后的底稿也要跟着重做');
  assert.equal(calls.length, 2, '不必把 auto、档位再挨个撞一遍');
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
  assert.match(submitted.notice, /放大 2/, '要明说这是放大过的，细节会软');
});

// ── 档位模式的宽高比：从画布比例自动推导 ────────────────────────────────
// Gemini 这类渠道只接受封闭集合里的几档比例，画布比例再怪也只能就近取一档。
// 这个推导以前不存在，只能让用户在渠道设置里手填 aspect_ratio——没人会为每张
// 画布改一次配置，于是空着，渠道按默认 3:2 出图，模型整张重画。
test('画布比例推导到最接近的标准宽高比', () => {
  const near = (w, h) => aspectForCanvas({ width: w, height: h });

  assert.equal(near(2600, 2560).ratio, '1:1', '1.016 的近方形画布该取 1:1');
  assert.ok(near(2600, 2560).skew < 0.02, '1.6% 的偏差属于可接受拉伸');

  assert.equal(near(3000, 2000).ratio, '3:2', '1.5 正好是 3:2');
  assert.equal(near(2000, 3000).ratio, '2:3', '竖构图要取倒数那一档，不能也取 3:2');
  assert.equal(near(1920, 1080).ratio, '16:9');
  assert.equal(near(1080, 1920).ratio, '9:16');
  assert.equal(near(1024, 768).ratio, '4:3');
  assert.equal(near(2400, 1000).ratio, '21:9', '2.4 最接近 21:9（2.33）');
  // 极扁的画布没有合适档位：偏差必须如实报出来，上层据此改走像素尺寸
  assert.ok(near(4000, 500).skew > 0.5, '8:1 的画布跟任何标准档都差很远');
});

test('底稿尺寸按宽高比算，长边固定 1536 并对齐到 16', () => {
  assert.deepEqual(aspectBox('1:1'), { width: 1536, height: 1536 });
  assert.deepEqual(aspectBox('3:2'), { width: 1536, height: 1024 });
  assert.deepEqual(aspectBox('2:3'), { width: 1024, height: 1536 });
  const wide = aspectBox('21:9');
  assert.equal(wide.width, 1536);
  assert.ok(Math.abs(wide.height - 1536 * 9 / 21) < 16, '高度按比例算，误差只来自 16 对齐');
});

test('大画布扩图上 4K 档，而不是被压成 1024 再放大', async () => {
  // 这是这一轮换 Gemini 的核心理由：2600×2560 的画布，
  //   像素尺寸 → 渠道一律回 1024×1024，放大 2.5 倍，糊
  //   4K 档 + 1:1 → 回 4096×4096，对画布是**缩小**，细节凭空多出来
  const png = await expandCanvas(2600, 2560, 1700);
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const form = init.body;
    seen.push({ size: form.get('image_size'), aspect: form.get('aspect_ratio') });
    const shot = await paintBand(form);
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gemini-3.1-flash-image', sizeMode: 'tier' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 1700, bottom: 2560 },
    n: 1
  });
  assert.equal(seen[0].size, '4K', '2600×2560 = 6.7MP，该走 4K 档');
  assert.equal(seen[0].aspect, '1:1', '近方形画布取 1:1');
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
  // 不再出现「按 1024 生成再放大」这种提示——这条路径已经不经过 1024 了
  assert.doesNotMatch(submitted.notice || '', /放大/);
});

test('4.1% 的比例偏差仍走 Gemini 档位，避免掉进无节点的自定义尺寸池', async () => {
  // 2026-11-13 现场：2048×2844 与 3:4 的对数比例差是 4.07%。档位入口写 4%，
  // 成片校验却写 5%，于是它刚好被入口踢到 image_size=1104x1536；中转把这个
  // 自定义值拼进路由模型名，连续四次 503「无可用渠道」。同渠道的 4K 档实际存在。
  const png = await sharp({ create: { width: 2048, height: 2560, channels: 4, background: { r: 110, g: 100, b: 90, alpha: 1 } } })
    .extend({ bottom: 284, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const form = init.body;
    seen.push({ tier: form.get('image_size'), aspect: form.get('aspect_ratio') });
    const shot = await paintBand(form);
    return new Response(JSON.stringify({ data: [{ b64_json: shot.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gemini-3.1-flash-image', sizeMode: 'tier' });
  const submitted = await provider.submit({
    operation: 'expand', prompt: '', n: 1,
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 2048, bottom: 2560 }
  });
  assert.deepEqual(seen[0], { tier: '4K', aspect: '3:4' });
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

// ── 渠道按提示词文本缓存安全判定 ──────────────────────────────────────────
// 实测记录（comfly + gemini-3.1-flash-image）：同一段扩图提示词被 451 拒过一次后，
// 之后一字不差地重发必然 451（连发四次全中，响应越来越快）；末尾加一个句号就通了，
// 加空格不行（渠道会归一化空白）。所以「内容安全」在这里不是随机的，
// 而是绑定在文本上的确定性判定——固定的提示词模板只要中一次，这条链路就永久失效。
test('每次扩图的提示词都带唯一编号，避免撞上被拦过的旧文本', async () => {
  const png = await expandCanvas();
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    prompts.push(init.body.get('prompt'));
    const painted = await paintBand(init.body, 0.62);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  await provider.submit({
    operation: 'expand',
    prompt: '',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
    n: 1
  });
  assert.match(prompts[0], /（请求编号 [a-z0-9]+1）/, '编号要真的进到提示词里');
});

// 三种形态的措辞本来就不同，所以「这一种被拦」不该等于整单失败。
test('请求被安全策略拦下时换形态继续试，而不是整单失败', async () => {
  const png = await expandCanvas();
  let calls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'The request was rejected by the content safety policy. Please revise the prompt or reference images.' } }), { status: 451, headers: { 'content-type': 'application/json' } });
    }
    const painted = await paintBand(init.body, 0.62);
    return new Response(JSON.stringify({ data: [{ b64_json: painted.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
    n: 1
  });
  assert.equal(calls, 2, '第一次被拦后应当真的再发一次');
  assert.equal(provider.poll(submitted.taskId).status, 'SUCCEEDED');
});

test('三种形态都被拦时给一条能照着改的报错，而不是空指针', async () => {
  const png = await expandCanvas();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'The request was rejected by the content safety policy.' } }), { status: 451, headers: { 'content-type': 'application/json' } });
  };
  const provider = createOpenAiCompatProvider({ fetchImpl, baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-image-2.6-flare' });
  await assert.rejects(
    () => provider.submit({
      operation: 'expand',
      prompt: '右边接着白墙',
      image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
      canvasBounds: { left: 0, top: 0, right: 640, bottom: 768 },
      n: 1
    }),
    (error) => {
      assert.equal(error.code, 'EXPAND_BLOCKED');
      assert.match(error.message, /换.*说法|换个说法/, '要告诉用户改措辞，而不是调比例');
      return true;
    }
  );
  assert.equal(calls, 3, '三种形态都该试过');
});
