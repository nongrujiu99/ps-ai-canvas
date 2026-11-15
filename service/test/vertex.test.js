const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  createVertexProvider,
  isVertexChannel,
  isVertexBaseUrl,
  isVertexApiKey,
  isVertexExpress,
  vertexGenerateUrl,
  vertexRoot,
  planPaddedCanvas,
  PROBE_MODEL,
  IMAGE_MODELS
} = require('../src/providers/vertex');
const { createChannelProbe } = require('../src/channel-probe');

const BASE = 'https://aiplatform.googleapis.com/v1';
const KEY = 'AQ.test-key-not-real';

// ── 地址拼接 ────────────────────────────────────────────────────────────────
// 四种写法用户都可能粘进来，必须收敛到同一条调用地址。
test('vertex endpoint is built from every base form the user might paste', () => {
  const want = 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.1-flash-image:generateContent';
  assert.equal(vertexGenerateUrl(BASE, 'gemini-3.1-flash-image'), want);
  // 少了 /v1
  assert.equal(vertexGenerateUrl('https://aiplatform.googleapis.com', 'gemini-3.1-flash-image'), want);
  // 末尾多一个斜杠
  assert.equal(vertexGenerateUrl('https://aiplatform.googleapis.com/v1/', 'gemini-3.1-flash-image'), want);
  // 带项目与区域的完整路径：不补 /v1，直接往后拼
  assert.equal(
    vertexGenerateUrl('https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1', 'gemini-3.1-flash-image'),
    'https://aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3.1-flash-image:generateContent'
  );
  // 用户把整条 endpoint 粘进来时，先剥掉模型段再拼，避免出现两段 publishers
  assert.equal(vertexGenerateUrl(want, 'gemini-3.1-flash-image'), want);
  assert.equal(vertexRoot(want), BASE);
});

test('vertex channel detection does not swallow ordinary relays', () => {
  assert.equal(isVertexBaseUrl(BASE), true);
  assert.equal(isVertexBaseUrl('https://ai.comfly.org/v1'), false);
  assert.equal(isVertexApiKey(KEY), true);
  assert.equal(isVertexApiKey('sk-abc'), false);

  assert.equal(isVertexChannel({ baseUrl: BASE, apiKey: KEY }), true);
  // 没有 /projects/ 的全局基址也算 Express，即便 Key 不是 AQ. 开头
  assert.equal(isVertexExpress({ baseUrl: BASE, apiKey: 'AIza-normal' }), true);
  // 带项目与区域：仍是 Vertex（同一条协议），但不属于 Express 的「全局基址」形态
  assert.equal(isVertexChannel({ baseUrl: BASE + '/projects/p1/locations/us-central1', apiKey: 'AIza-normal' }), true);
  assert.equal(isVertexExpress({ baseUrl: BASE + '/projects/p1/locations/us-central1', apiKey: 'AIza-normal' }), false);
  // 普通中转站不能落到 Vertex 适配器上
  assert.equal(isVertexChannel({ baseUrl: 'https://ai.comfly.org/v1', apiKey: 'sk-abc' }), false);
});

// ── 连通测试：探针，不碰 /models ────────────────────────────────────────────
// Express Mode 的 AQ. Key 调 GET /models 固定 401，用它测连通等于必然误报。
test('connectivity test probes generateContent instead of listing models', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }] })
    };
  };
  const probe = createChannelProbe({ fetchImpl });
  const result = await probe({ baseUrl: BASE, apiKey: KEY, model: '', sizeMode: 'tier' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE + '/publishers/google/models/' + PROBE_MODEL + ':generateContent');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-goog-api-key'], KEY);
  assert.equal(calls[0].init.headers.Authorization, undefined, '原生接口收到 Bearer 会 401');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig.maxOutputTokens, 1, '探针必须限制到 1 个 token');
  assert.equal(body.contents[0].parts[0].text, 'hi');

  assert.equal(result.ok, true);
  assert.equal(result.probe, 'vertex-generate-content');
  assert.equal(result.probeModel, PROBE_MODEL);
  assert.equal(result.modelFound, null, '没有列表就不能假装核过模型名');
  assert.equal(calls.some((call) => /\/models$/.test(call.url)), false, '绝不能回头去敲 /models');
});

test('a rejected vertex key fails with an explanation instead of a fake pass', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"error":{"code":401,"message":"API keys are not supported by this API."}}' });
  await assert.rejects(createChannelProbe({ fetchImpl })({ baseUrl: BASE, apiKey: KEY, model: '' }), (error) => {
    assert.equal(error.code, 'CHANNEL_TEST_FAILED');
    assert.match(error.message, /401/);
    assert.match(error.message, /x-goog-api-key/, '要说清 Key 该怎么传');
    return true;
  });
});

test('probing a vertex endpoint without /v1 says where the path should point', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '{"error":{"code":404}}' });
  await assert.rejects(
    createChannelProbe({ fetchImpl })({ baseUrl: 'https://aiplatform.googleapis.com', apiKey: KEY, model: '' }),
    (error) => {
      assert.equal(error.code, 'CHANNEL_TEST_FAILED');
      assert.match(error.message, /404/);
      assert.match(error.message, /aiplatform\.googleapis\.com\/v1/);
      return true;
    }
  );
});

// ── 请求形态与结果解析 ─────────────────────────────────────────────────────
async function canvasWithBottomStrip() {
  const W = 512;
  const H = 704;
  const photoH = 640;
  const pixels = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      pixels[i] = 120;
      pixels[i + 1] = 100;
      pixels[i + 2] = 80;
      pixels[i + 3] = y < photoH ? 255 : 0;
    }
  }
  return { W, H, photoH, png: await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() };
}

function vertexReply(pngBase64) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBase64 } }] } }]
    })
  };
}

test('expand sends a ratio-matched canvas and keeps only the new strips', async () => {
  const { W, H, photoH, png } = await canvasWithBottomStrip();
  const calls = [];
  // 模型回什么颜色不重要：合成阶段只取新增条带，照片区必须是透明的。
  const replyPng = await sharp({ create: { width: 528, height: 704, channels: 3, background: '#8a6a4a' } }).png().toBuffer();
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return vertexReply(replyPng.toString('base64'));
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image' });

  const submitted = await provider.submit({
    operation: 'expand',
    prompt: '自然延伸桌面',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    canvasBounds: { left: 0, top: 0, right: W, bottom: photoH },
    n: 1
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig.responseModalities.join(','), 'IMAGE');
  // 512×704 的比例是 0.727，最近的档位是 3:4；补到 528×704 后比例正好，
  // 出图再缩放回来就不会被拉伸。
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '3:4');
  const sent = Buffer.from(body.contents[0].parts[0].inlineData.data, 'base64');
  const sentMeta = await sharp(sent).metadata();
  assert.equal(sentMeta.width, 528);
  assert.equal(sentMeta.height, 704);
  assert.match(body.contents[0].parts[1].text, /扩图|延伸|衔接/);

  const polled = await provider.poll(submitted.taskId);
  assert.equal(polled.status, 'SUCCEEDED');
  const out = await provider.download(polled.resultUrls[0]);
  const raw = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, W);
  assert.equal(raw.info.height, H);
  const alphaAt = (x, y) => raw.data[(y * W + x) * 4 + 3];
  assert.equal(alphaAt(100, 100), 0, '照片区必须保持透明');
  assert.equal(alphaAt(100, H - 20), 255, '新增条带必须有像素');
});

test('text-to-image sends the documented generation config', async () => {
  const calls = [];
  const replyPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return vertexReply(replyPng.toString('base64')); };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-nano-banana-2.1' });

  await provider.submit({ operation: 'generate', prompt: '一只白猫', size: '1024*1024', n: 1 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts.length, 1);
  assert.equal(body.contents[0].parts[0].text, '一只白猫');
  assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE']);
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '1K' });
  // 没填种子也要摇一个发出去：这张模型的种子是真生效的，不传就等于「这次用了什么
  // 种子没人知道」，出了满意的一张没法复现。
  assert.ok(Number.isInteger(body.generationConfig.seed), '留空时要自己摇一个种子');
  assert.ok(body.generationConfig.seed >= 0 && body.generationConfig.seed <= 2147483647);
  assert.equal(calls[0].url, BASE + '/publishers/google/models/gemini-nano-banana-2.1:generateContent');
});

test('a candidate without inlineData reports what the model said', async () => {
  const { png } = await canvasWithBottomStrip();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'I cannot edit that.' }] }, finishReason: 'SAFETY' }]
    })
  });
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });
  await assert.rejects(provider.submit({
    operation: 'editWhole',
    prompt: '换背景',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
  }), (error) => {
    assert.equal(error.code, 'VERTEX_NO_IMAGE');
    assert.match(error.message, /SAFETY/);
    assert.match(error.message, /cannot edit/);
    return true;
  });
});

// 实测过：同一条通道、同一份配置，探针 200，紧接着出图 ECONNRESET，手动再点一次又 200。
// 这类抖动与 Key、地址、模型名都无关，重试就该过；直接报「连不上、要代理」会把人带偏。
test('a dropped connection is retried instead of being blamed on the config', async () => {
  const replyPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      throw error;
    }
    return vertexReply(replyPng.toString('base64'));
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image' });
  const started = Date.now();

  const job = await provider.submit({ operation: 'generate', prompt: '一只白猫', size: '1024*1024', n: 1 });
  assert.equal(attempts, 2, '第一次 reset 之后必须自己再发一次');
  assert.ok(Date.now() - started >= 600, '重试要有退避，不能立刻打回去');
  const state = await provider.poll(job.taskId);
  assert.equal(state.status, 'SUCCEEDED');
  const bytes = await provider.download(state.resultUrls[0]);
  assert.ok(bytes.length > 0, '重试成功后结果要能取到');
});

test('a connection that keeps dropping still ends with an actionable message', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    throw error;
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image' });
  await assert.rejects(provider.submit({ operation: 'generate', prompt: 'x', size: '1024*1024', n: 1 }), (error) => {
    assert.equal(error.code, 'VERTEX_UNREACHABLE');
    assert.match(error.message, /ECONNRESET/);
    return true;
  });
  assert.equal(attempts, 3, '一共试三次就该停，不能无限重试');
});

test('a missing model names the model and the likely address problem', async () => {
  const { png } = await canvasWithBottomStrip();
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ error: { code: 404, message: 'Publisher model `gemini-nano-banana-2.1` was not found' } })
  });
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-nano-banana-2.1' });
  await assert.rejects(provider.submit({
    operation: 'editWhole',
    prompt: 'x',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
  }), (error) => {
    assert.equal(error.code, 'VERTEX_MODEL_MISSING');
    assert.match(error.message, /gemini-nano-banana-2\.1/);
    return true;
  });
});

// 选区编辑不能整张送：模型会顺手重画整幅，选区边缘就对不上了。
// 这里验的是「只送选区那块」，以及「选区外的像素原样回来」。
test('selection edit only sends the selected area and leaves the rest untouched', async () => {
  const W = 512;
  const H = 704;
  const pixels = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      pixels[i] = 30; pixels[i + 1] = 40; pixels[i + 2] = 50; pixels[i + 3] = 255;
    }
  }
  const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  // 选区 = 白块 (100,100)-(300,300)
  const mask = await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } })
    .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toBuffer(), left: 100, top: 100 }])
    .png().toBuffer();

  const calls = [];
  const replyPng = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return vertexReply(replyPng.toString('base64')); };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  const submitted = await provider.submit({
    operation: 'editMasked',
    prompt: '把这块换成红色',
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
    mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') },
    n: 1
  });

  const body = JSON.parse(calls[0].init.body);
  const sentMeta = await sharp(Buffer.from(body.contents[0].parts[0].inlineData.data, 'base64')).metadata();
  // 200×200 的选区 + 30% 上下文 = 320×320，远小于整张画布。
  assert.equal(sentMeta.width, 320);
  assert.equal(sentMeta.height, 320);

  const out = await provider.download((await provider.poll(submitted.taskId)).resultUrls[0]);
  const raw = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.width, W);
  assert.equal(raw.info.height, H);
  // 选区外（比如左上角）必须还是原像素：模型碰不到那里。
  assert.deepEqual([...raw.data.subarray(0, 3)], [30, 40, 50]);
  // 选区内应当是模型画的那块。
  const inside = ((150 * W) + 150) * 4;
  assert.equal(raw.data[inside], 255);
});

test('the provider refuses a non-vertex address instead of silently mis-calling', () => {
  assert.throws(() => createVertexProvider({ baseUrl: 'https://ai.comfly.org/v1', apiKey: KEY }), (error) => {
    assert.equal(error.code, 'INVALID_ENDPOINT');
    return true;
  });
});

// 内置清单是 Express Mode 唯一的模型来源：它必须只含实测存在的模型 ID。
// Nano Banana 是昵称不是 ID——gemini-nano-banana-2.1 在 Vertex 上一律 404 NOT_FOUND，
// 把它列进来等于给人一个必然失败的选项。
test('built-in image models only list ids that exist on vertex', () => {
  assert.ok(IMAGE_MODELS.includes('gemini-3.1-flash-image'), '新一代主力要在清单里');
  assert.ok(IMAGE_MODELS.includes('gemini-3-pro-image'), 'pro 档要在清单里');
  assert.equal(IMAGE_MODELS[0], 'gemini-3.1-flash-image', '默认模型应当是实测可用的那个');
  assert.ok(!IMAGE_MODELS.some((id) => /nano-banana/.test(id)), '昵称不能当模型 ID');
  const padded = planPaddedCanvas({ width: 2048, height: 2844 });
  assert.equal(padded.ratio, '3:4');
  assert.equal(padded.width, 2133);
  assert.equal(padded.top, 0);
});

// ── 生图参数要真的生效 ──────────────────────────────────────────────────────
// imageConfig.imageSize 只是档位：2K 的 16:9 实测回来是 2752×1536，比面板上写的
// 2048×1152 大一圈。不缩回去的话，面板的「输出尺寸」就是假的，用户拿到的图还得自己缩放。
test('generate returns exactly the size the panel asked for', async () => {
  const tierPng = await sharp({ create: { width: 2752, height: 1536, channels: 3, background: '#3a5f8a' } }).png().toBuffer();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return vertexReply(tierPng.toString('base64')); };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  const job = await provider.submit({ operation: 'generate', prompt: '一只白猫', size: '2048*1152', n: 1 });
  const state = await provider.poll(job.taskId);
  const meta = await sharp(await provider.download(state.resultUrls[0])).metadata();

  assert.equal(meta.width, 2048, '宽度要被缩回面板写的尺寸');
  assert.equal(meta.height, 1152);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '16:9');
  assert.equal(body.generationConfig.imageConfig.imageSize, '2K');
});

// 候选数量与种子：Vertex 一次只回一个候选（传 candidateCount 会 400），但 seed 是
// 合法字段。面板上两个输入框都在，行为必须一致——能发的发出去，做不到的说清楚。
test('generate forwards the seed and admits when only one candidate is possible', async () => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#888888' } }).png().toBuffer();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return vertexReply(png.toString('base64')); };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY });

  const job = await provider.submit({ operation: 'generate', prompt: '一只白猫', size: '1024*1024', n: 3, seed: 1234 });

  assert.equal(calls.length, 1, 'candidateCount 传了就 400，只能发一次');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig.seed, 1234, '种子要真的发出去，否则输入框是摆设');
  assert.equal(body.generationConfig.candidateCount, undefined, '不能传 candidateCount');
  assert.match(job.notice, /一次只出一张/, '只出一张时必须说出来');
});

// ── 连不上 ≠ 等太久 ─────────────────────────────────────────────────────────
// 真实事故：用户点扩图，14 秒就失败，面板却写「Vertex 在 180 秒内没有返回，
// 4K 出图本来就慢」。实际是 DNS 解析不了 / 代理 CONNECT 被掐——请求根本没到 Google。
// 文案错了，用户就会去重试 4K、去调档位，永远不会去看代理。
test('a DNS failure is reported as unreachable, not as a slow model', async () => {
  const fetchImpl = async () => {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('getaddrinfo ENOTFOUND aiplatform.googleapis.com'), { code: 'ENOTFOUND' });
    throw error;
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image' });
  await assert.rejects(provider.submit({ operation: 'generate', prompt: 'x', size: '1024*1024', n: 1 }), (error) => {
    assert.equal(error.code, 'VERTEX_UNREACHABLE');
    assert.doesNotMatch(error.message, /秒内没有返回/, '连不上的请求不能报成超时');
    assert.match(error.message, /ENOTFOUND/);
    assert.match(error.message, /代理|TUN/, '要告诉用户下一步去看什么');
    return true;
  });
});

// ENOTFOUND / ECONNREFUSED 是确定的，重试只是把同样的失败再等一遍（每次 10 秒）。
test('a deterministic connect failure is not retried', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6893'), { code: 'ECONNREFUSED' });
    throw error;
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image' });
  await assert.rejects(provider.submit({ operation: 'generate', prompt: 'x', size: '1024*1024', n: 1 }));
  assert.equal(attempts, 1, '代理端口没开就不是抖动，重试没有意义');
});

// 代理握手超时在 undici 里是 AbortError/UND_ERR_ABORTED，和「我们自己掐的等待超时」
// 长得一模一样。必须靠 timedOut 标记区分，否则又会被报成「N 秒内没有返回」。
test('a proxy handshake abort is classified as connect, not as a wait timeout', async () => {
  let attempts = 0;
  const fetchImpl = async (url, init) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('aborted'), { code: 'UND_ERR_ABORTED' });
      throw error;
    }
    return vertexReply((await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64'));
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image' });
  await provider.submit({ operation: 'generate', prompt: 'x', size: '1024*1024', n: 1 });
  assert.equal(attempts, 2, '握手超时属于抖动，要再试一次');
});

// 真正的等待超时：请求已经发出去了，等了很久没有回话。这时重试也没用（可能还在计费），
// 直接报超时，并说明「每次卡在同一秒数 = 线路问题」。
test('a real wait timeout reports the seconds it actually waited', async () => {
  let attempts = 0;
  const fetchImpl = async (url, init) => {
    attempts += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const provider = createVertexProvider({ fetchImpl, baseUrl: BASE, apiKey: KEY, model: 'gemini-3.1-flash-image', requestTimeoutMs: 120 });
  await assert.rejects(provider.submit({ operation: 'generate', prompt: 'x', size: '1024*1024', n: 1 }), (error) => {
    assert.equal(error.code, 'VERTEX_TIMEOUT');
    assert.match(error.message, /0 秒内没有回话|秒内没有回话/);
    return true;
  });
  assert.equal(attempts, 1, '等待超时不重试：可能还在计费');
});
