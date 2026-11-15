const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createServer } = require('../src/server');
const clientToken = 'a'.repeat(43);

async function fixture() {
  const pixels = Buffer.alloc(512 * 512 * 4, 255);
  const png = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
  const gray = Buffer.alloc(512 * 512, 0);
  gray.fill(255, 0, 16);
  const mask = await sharp(gray, { raw: { width: 512, height: 512, channels: 1 } }).png().toBuffer();
  return { image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }, mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + mask.toString('base64') } };
}

async function withServer(run, configured = true, options = {}) {
  const submitted = [];
  const credentialStore = { read: async () => configured ? { apiKey: 'secret-test-key', workspaceId: 'workspace' } : null, save: async () => {} };
  const jobManager = { start: async (job) => { submitted.push(job); return { jobId: '11111111-1111-4111-8111-111111111111', status: 'pending' }; }, get: () => ({ jobId: '11111111-1111-4111-8111-111111111111', status: 'succeeded', resultCount: 1, errorCode: null }), getResult: () => Buffer.from('result-png'), cancelWait: () => ({ jobId: '11111111-1111-4111-8111-111111111111', status: 'cancelled' }), ...options.jobManager };
  const server = createServer({ jobManager, credentialStore, allowedOrigins: ['plugin://studio', 'null'], clientToken, ...options.server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run({ base: `http://127.0.0.1:${server.address().port}`, submitted }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const headers = { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': clientToken, 'Content-Type': 'application/json', Origin: 'plugin://studio' };

test('non-billable inspection classifies a normal selection without submitting a job', async () => {
  await withServer(async ({ base, submitted }) => {
    const body = await fixture();
    const response = await fetch(base + '/v1/inspect', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selectionKind, 'inside');
    assert.equal(submitted.length, 0);
  });
});

test('a valid generation job is accepted once and can be polled', async () => {
  await withServer(async ({ base, submitted }) => {
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: '白色花瓶' }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).jobId, '11111111-1111-4111-8111-111111111111');
    assert.equal(submitted.length, 1);
    const status = await fetch(base + '/v1/jobs/11111111-1111-4111-8111-111111111111', { headers: { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': clientToken, Origin: 'plugin://studio' } });
    assert.equal((await status.json()).resultCount, 1);
  });
});

test('foreign browser origin and missing plugin header cannot create a billable job', async () => {
  await withServer(async ({ base, submitted }) => {
    const body = JSON.stringify({ operation: 'generate', prompt: '花瓶' });
    const foreign = await fetch(base + '/v1/jobs', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body });
    const missing = await fetch(base + '/v1/jobs', { method: 'POST', headers: { Origin: 'plugin://studio', 'Content-Type': 'application/json' }, body });
    assert.equal(foreign.status, 403);
    assert.equal(missing.status, 403);
    assert.equal(submitted.length, 0);
  });
});

test('an opaque browser origin cannot use the fixed client label without the private connection code', async () => {
  await withServer(async ({ base, submitted }) => {
    const body = JSON.stringify({ operation: 'generate', prompt: '花瓶' });
    const preflight = await fetch(base + '/v1/jobs', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'X-STUDIO-Client, X-STUDIO-Token, Content-Type' } });
    assert.equal(preflight.status, 204);
    const billable = await fetch(base + '/v1/jobs', { method: 'POST', headers: { ...headers, Origin: 'null', 'X-STUDIO-Token': '' }, body });
    const overwrite = await fetch(base + '/v1/settings/key', { method: 'PUT', headers: { ...headers, Origin: 'null', 'X-STUDIO-Token': '' }, body: JSON.stringify({ apiKey: 'attacker', workspaceId: 'attacker' }) });
    assert.equal(billable.status, 403);
    assert.equal(overwrite.status, 403);
    assert.equal(submitted.length, 0);
  });
});

test('malformed JSON, wrong content type, and missing key fail before submission', async () => {
  await withServer(async ({ base, submitted }) => {
    const malformed = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: '{' });
    const wrongType = await fetch(base + '/v1/jobs', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(malformed.status, 400);
    assert.equal(wrongType.status, 415);
    assert.equal(submitted.length, 0);
  });
  await withServer(async ({ base, submitted }) => {
    const missingKey = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: '花瓶' }) });
    assert.equal(missingKey.status, 409);
    assert.equal(submitted.length, 0);
  }, false);
});

test('whole repaint with an irregular transparent hole is rejected before billing', async () => {
  await withServer(async ({ base, submitted }) => {
    const pixels = Buffer.alloc(512 * 512 * 4, 255);
    pixels[(256 * 512 + 256) * 4 + 3] = 0;
    const png = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
    const image = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') };
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'editWhole', prompt: '黄昏', image }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'IRREGULAR_TRANSPARENCY');
    assert.equal(submitted.length, 0);
  });
});

test('errors and credential status never expose a stored API key', async () => {
  await withServer(async ({ base }) => {
    const status = await fetch(base + '/v1/settings/status', { headers: { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': clientToken, Origin: 'plugin://studio' } });
    assert.deepEqual(await status.json(), { configured: true, workspaceId: 'workspace' });
    const failed = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'editWhole', prompt: '' }) });
    assert.equal((await failed.text()).includes('secret-test-key'), false);
  });
});

test('oversized JSON is rejected before a paid submission', async () => {
  await withServer(async ({ base, submitted }) => {
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: 'a'.repeat(1024) }) });
    assert.equal(response.status, 413);
    assert.equal(submitted.length, 0);
  }, true, { server: { maxBodyBytes: 256 } });
});

test('result PNG and raw RGBA endpoints return local bytes and dimensions', async () => {
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: '#123456' } }).png().toBuffer();
  await withServer(async ({ base }) => {
    const url = base + '/v1/results/11111111-1111-4111-8111-111111111111/0';
    const pngResponse = await fetch(url, { headers: { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': clientToken, Origin: 'plugin://studio' } });
    assert.equal(pngResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), png);
    const rawResponse = await fetch(url + '/raw', { headers: { 'X-STUDIO-Client': 'studio-plugin', 'X-STUDIO-Token': clientToken, Origin: 'plugin://studio' } });
    assert.equal(rawResponse.headers.get('x-image-width'), '2');
    assert.equal(rawResponse.headers.get('x-image-height'), '3');
    assert.match(rawResponse.headers.get('access-control-expose-headers') || '', /X-Image-Width/);
    assert.equal((await rawResponse.arrayBuffer()).byteLength, 24);
  }, true, { jobManager: { getResult: () => png } });
});

test('POST /v1/jobs/:id/recover 只重下结果，不新建任务', async () => {
  let recovered = 0;
  const jobManager = {
    recover: (id) => { recovered += 1; return { jobId: id, status: 'succeeded', resultCount: 1 }; },
  };
  await withServer(async ({ base, submitted }) => {
    const response = await fetch(base + '/v1/jobs/11111111-1111-4111-8111-111111111111/recover', { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'succeeded');
    assert.equal(recovered, 1);
    assert.equal(submitted.length, 0, '重下不该提交新的生成任务');
  }, true, { jobManager });
});

test('the channel test endpoint probes without saving anything', async () => {
  const saved = [];
  const seen = [];
  const channelStore = {
    resolveDraft: async (input) => ({ baseUrl: input.baseUrl, model: input.model, apiKey: 'sk', sizeMode: 'tier' }),
    save: async (input) => { saved.push(input); return {}; }
  };
  const channelTester = async (draft) => { seen.push(draft); return { ok: true, model: draft.model, modelFound: true, modelCount: 2, similar: [], latencyMs: 12 }; };
  await withServer(async ({ base }) => {
    const response = await fetch(base + '/v1/channel/test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'openai', baseUrl: 'https://ai.example.com/v1', apiKey: 'sk', model: 'gemini-3.1-flash-image', sizeMode: 'tier' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.modelFound, true);
    assert.equal(seen.length, 1, '应该真的去敲了一次渠道');
    assert.equal(saved.length, 0, '测试不应该保存渠道设置');
  }, true, { server: { channelStore, channelTester } });
});

test('a rejected key surfaces as a panel-readable error with its code', async () => {
  const channelStore = { resolveDraft: async () => ({ baseUrl: 'https://ai.example.com/v1', model: 'm', apiKey: 'sk', sizeMode: 'tier' }) };
  const channelTester = async () => { const error = new Error('Key 被拒绝（HTTP 401）：这个 Key 不对。'); error.code = 'CHANNEL_TEST_FAILED'; throw error; };
  await withServer(async ({ base }) => {
    const response = await fetch(base + '/v1/channel/test', { method: 'POST', headers, body: JSON.stringify({ kind: 'openai' }) });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'CHANNEL_TEST_FAILED');
    assert.match(body.message, /401/);
  }, true, { server: { channelStore, channelTester } });
});

// 11 月 13 日用户报的「识别不对」：2048×2844 的画布，活动层停在底部那条
// 285 高的透明带上。这个范围能过 saneBounds，于是被当成原照片——而它其实只是
// 画面的一角。真实画布上只有下方 284px 是新增区，正确倍率是 1.111。
test('a layer bounds sitting on the transparency still yields scales from the real photo area', async () => {
  await withServer(async ({ base, submitted }) => {
    // 512×512 画布：上方 384 行是照片，下方 128 行透明（1.333 = 384+128/384）。
    const png = await sharp({ create: { width: 512, height: 384, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
      .extend({ bottom: 128, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    // 活动层是画面下半部的一块：高 262，只盖住照片的下 134 行（35%）。
    // 拿它算会得到「上 1.95 / 下 1.0」——一个边界完全合法、但方向完全相反的结果，
    // 比算不出来更危险：它不用经过上限过滤，会直接被采用。
    const body = {
      image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
      context: { layerBounds: { left: 0, top: 250, right: 512, bottom: 512 } }
    };
    const response = await fetch(base + '/v1/inspect', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const inspection = await response.json();
    assert.equal(inspection.selectionKind, 'none');
    assert.ok(inspection.expandScales, '拿错范围时应该退回透明区反推，而不是放弃推导');
    assert.equal(Number(inspection.expandScales.bottom.toFixed(3)), 1.333);
    assert.equal(inspection.expandScales.top, 1, '方向必须是「往下扩」，不能算成往上');
    assert.equal(inspection.expandScales.left, 1);
    assert.equal(inspection.expandScales.right, 1);
    assert.deepEqual(inspection.expandBounds, { left: 0, top: 0, right: 512, bottom: 384 }, '用于生成的照片范围也必须一起返回');
    assert.equal(submitted.length, 0, '推导是只读的，不该产生任务');
  });
});

// 反向保证：范围确实盖住了照片时，仍然优先用 Photoshop 报的那个（它不受
// 半透明描边影响，比逐像素反推准）。别把「筛掉错范围」做成「永远不用它」。
test('a layer bounds that covers the photo is still preferred over the alpha bounds', async () => {
  await withServer(async ({ base }) => {
    // 照片边缘留 8px 半透明的「柔和投影」：alpha 反推会把不透明区算小，
    // 于是下方扩张被算成 1.4 左右；而图层范围知道真实照片到 384 为止。
    const png = await sharp({ create: { width: 512, height: 376, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
      .extend({ bottom: 136, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    const body = {
      image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') },
      context: { layerBounds: { left: 0, top: 0, right: 512, bottom: 384 } }
    };
    const response = await fetch(base + '/v1/inspect', { method: 'POST', headers, body: JSON.stringify(body) });
    const inspection = await response.json();
    assert.ok(inspection.expandScales);
    // 384 高的原图 + 128 的透明区 → 1.333；若用了 alpha 反推的 376 会得到 1.34+
    assert.equal(Number(inspection.expandScales.bottom.toFixed(3)), 1.333);
    assert.deepEqual(inspection.expandBounds, { left: 0, top: 0, right: 512, bottom: 384 }, '返回的范围要与倍率来自同一个候选');
  });
});

// 旧面板只修好了倍率显示，提交时仍把活动图层的透明带当 canvasBounds。
// 服务端是计费前的最后一道边界：即使客户端没更新，也不能拿错误范围去做遮罩和提示词。
test('a job with a transparent-strip canvasBounds is corrected before it reaches the provider', async () => {
  await withServer(async ({ base, submitted }) => {
    const png = await sharp({ create: { width: 512, height: 384, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
      .extend({ bottom: 128, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    const image = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') };
    const response = await fetch(base + '/v1/jobs', {
      method: 'POST', headers,
      body: JSON.stringify({
        operation: 'expand', prompt: '', n: 1, image,
        scales: { top: 1, right: 1, bottom: 1.3333333333, left: 1 },
        canvasBounds: { left: 0, top: 383, right: 512, bottom: 512 }
      })
    });
    assert.equal(response.status, 202);
    assert.deepEqual(submitted[0].canvasBounds, { left: 0, top: 0, right: 512, bottom: 384 });
  });
});

// ── 原图对照 ──────────────────────────────────────────────────────
// 面板要能点开结果做「原图 ↔ 生成后」滑块对比。这一步在服务端成立的前提是
// 提交时把抓到的底稿压一张小的留下来——面板那头 CEP 是 data URL、UXP 是裸 RGBA，
// 等结果回来再各自想办法，必然两端分叉。
test('提交任务时留下原图缩小版，GET /origin 直接回 PNG', async () => {
  const received = [];
  await withServer(async ({ base }) => {
    const body = await fixture();
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'editWhole', prompt: '黄昏', image: body.image }) });
    assert.equal(response.status, 202);
    assert.equal(received.length, 1);
    assert.ok(Buffer.isBuffer(received[0].origin), '提交时必须把原图预览一并交给任务');
    const meta = await sharp(received[0].origin).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 512);
    assert.equal(meta.hasAlpha, true, '压掉 alpha，扩图的新增区会变成一块黑');

    const origin = await fetch(base + '/v1/jobs/11111111-1111-4111-8111-111111111111/origin', { headers });
    assert.equal(origin.status, 200);
    assert.equal(origin.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await origin.arrayBuffer()), received[0].origin);
  }, true, {
    jobManager: {
      start: async (job, extra) => { received.push(extra); return { jobId: '11111111-1111-4111-8111-111111111111', status: 'pending' }; },
      getOrigin: (id) => { assert.equal(id, '11111111-1111-4111-8111-111111111111'); return received[0].origin; },
    },
  });
});

// 纯生成没有底稿。给个 null 而不是空 Buffer：面板据此显示「单图预览」，
// 而不是画一个拖了没反应的滑块。
test('纯生成任务不产生原图预览', async () => {
  const received = [];
  await withServer(async ({ base }) => {
    const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ operation: 'generate', prompt: '白色花瓶' }) });
    assert.equal(response.status, 202);
    assert.equal(received[0].origin, null);
  }, true, {
    jobManager: {
      start: async (job, extra) => { received.push(extra); return { jobId: '11111111-1111-4111-8111-111111111111', status: 'pending' }; },
    },
  });
});
