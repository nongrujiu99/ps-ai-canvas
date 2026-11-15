const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannelProbe } = require('../src/channel-probe');

const DRAFT = { baseUrl: 'https://ai.example.com/v1', model: 'gemini-3.1-flash-image', apiKey: 'sk-test', sizeMode: 'tier' };

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

// 中转站的错误体是 JSON 文本，探针要读正文才知道「路径错了」还是「没有这个接口」。
function textResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test('a model listed by the channel comes back as a hit', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(200, { data: [{ id: 'gemini-3.1-flash-image' }, { id: 'gpt-image-2.6-flare' }] }));
  const probe = createChannelProbe({ fetchImpl });
  const result = await probe(DRAFT);

  assert.equal(result.ok, true);
  assert.equal(result.modelFound, true);
  assert.equal(result.modelCount, 2);
  assert.equal(result.model, 'gemini-3.1-flash-image');
  assert.ok(result.latencyMs >= 0);
  assert.equal(fetchImpl.calls[0].url, 'https://ai.example.com/v1/models');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-test');
});

test('a missing model is reported as a miss with image candidates to pick from', async () => {
  // 中文/无效名字也要能走通：只在列表里找不到时给候选，不能因为找不到就报错。
  const fetchImpl = fakeFetch(async () => jsonResponse(200, {
    data: [{ id: 'gemini-3.1-flash-image' }, { id: 'gpt-image-2.6-flare' }, { id: 'gpt-4o' }, { id: 'text-embedding-3' }]
  }));
  const result = await createChannelProbe({ fetchImpl })({ ...DRAFT, model: 'gemini-3-pro-image' });

  assert.equal(result.ok, true);
  assert.equal(result.modelFound, false);
  assert.deepEqual(result.similar, ['gemini-3.1-flash-image', 'gpt-image-2.6-flare']);
});

test('models/ prefix and case differences still count as a hit', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(200, { data: [{ id: 'models/Gemini-3.1-Flash-Image' }] }));
  const result = await createChannelProbe({ fetchImpl })(DRAFT);
  assert.equal(result.modelFound, true);
});

test('a rejected key fails with the status spelled out', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(401, { error: 'invalid api key' }));
  await assert.rejects(createChannelProbe({ fetchImpl })(DRAFT), (error) => {
    assert.equal(error.code, 'CHANNEL_TEST_FAILED');
    assert.match(error.message, /401/);
    assert.match(error.message, /Key/);
    return true;
  });
});

test('a channel without /models is not treated as a failure, only as unverifiable', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(404, {}));
  const result = await createChannelProbe({ fetchImpl })(DRAFT);
  assert.equal(result.ok, true);
  assert.equal(result.modelFound, null);
  assert.equal(result.modelCount, 0);
});

// 实测 ai.comfly.org：地址写成 /v2 时返回 404，正文是
// "Invalid URL (GET /v2/models), you may need [GET /v1/models, ...]"。
// 这种情况下生成也会 404，所以必须报失败，而不是上一行那种「能连上」。
test('a 404 that names the right path is an address error, not a pass', async () => {
  const body = '{"error":{"message":"Invalid URL (GET /v2/models), you may need [GET /v1/models, GET /v1beta/models]"}}';
  const fetchImpl = fakeFetch(async () => textResponse(404, body));
  await assert.rejects(createChannelProbe({ fetchImpl })({ ...DRAFT, baseUrl: 'https://ai.example.com/v2' }), (error) => {
    assert.equal(error.code, 'CHANNEL_TEST_FAILED');
    assert.match(error.message, /404/);
    assert.match(error.message, /\/v2\/models/, '要指出用户填的是哪条路径');
    assert.match(error.message, /\/v1\/models/, '要指出渠道认的是哪条');
    assert.match(error.message, /https:\/\/ai\.example\.com\/v1/, '要给一条能直接粘回去的地址');
    return true;
  });
});

test('a 404 whose body is html (a web page, not an api) stays unverifiable', async () => {
  // 地址指到一个网站首页时是 200 + HTML，解析不出列表；这种不判失败——面板会说「核不了模型名」。
  const fetchImpl = fakeFetch(async () => textResponse(404, '<!doctype html><html><body>Not Found</body></html>'));
  const result = await createChannelProbe({ fetchImpl })(DRAFT);
  assert.equal(result.ok, true);
  assert.equal(result.modelFound, null);
});

test('a 404 that only echoes the path we asked for does not pretend to know better', async () => {
  // 渠道没给建议、正文只重复了请求路径时，不能把「改回同一个地址」当成解法。
  const body = '{"error":{"message":"Invalid URL (GET /v1/models)"}}';
  const fetchImpl = fakeFetch(async () => textResponse(404, body));
  const result = await createChannelProbe({ fetchImpl })(DRAFT);
  assert.equal(result.ok, true);
  assert.equal(result.modelFound, null);
});

test('an unreadable body is also unverifiable rather than a hard error', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
  const result = await createChannelProbe({ fetchImpl })(DRAFT);
  assert.equal(result.modelFound, null);
});

test('a connection failure names the cause code so the user knows where it broke', async () => {
  const error = new Error('fetch failed');
  error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  const fetchImpl = fakeFetch(async () => { throw error; });
  await assert.rejects(createChannelProbe({ fetchImpl })(DRAFT), (thrown) => {
    assert.equal(thrown.code, 'CHANNEL_TEST_FAILED');
    assert.match(thrown.message, /ECONNREFUSED/);
    assert.match(thrown.message, /连不上/);
    return true;
  });
});

test('a timeout says how long it waited instead of blaming the key', async () => {
  const error = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const fetchImpl = fakeFetch(async () => { throw error; });
  await assert.rejects(createChannelProbe({ fetchImpl, timeoutMs: 15000 })(DRAFT), (thrown) => {
    assert.match(thrown.message, /超时/);
    assert.match(thrown.message, /15 秒/);
    return true;
  });
});

test('a 5xx is reported as reachable but refused', async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse(500, {}));
  await assert.rejects(createChannelProbe({ fetchImpl })(DRAFT), (error) => {
    assert.match(error.message, /HTTP 500/);
    return true;
  });
});

// ── 握手分段计时 ────────────────────────────────────────────────────────────
// 面板上加这一项的理由：fetch 只给一个总 latencyMs，分不清「Google 在排队」和
// 「这条线路本身慢」。实测出现过 DNS 1.4s、TLS 3.3s 的线路，那数字摆出来，
// 用户就知道今晚该不该拿它去出 4K 图。
test('handshake timings skip non-https addresses instead of faking numbers', async () => {
  const { handshakeTimings } = require('../src/channel-probe');
  assert.equal(await handshakeTimings('http://127.0.0.1:32145'), null);
  assert.equal(await handshakeTimings('not-a-url'), null);
});

test('handshake timings report the failure code when the port is closed', async () => {
  const { handshakeTimings } = require('../src/channel-probe');
  const started = Date.now();
  const result = await handshakeTimings('https://127.0.0.1:1', 3000);
  assert.ok(result, '连不上也要给结论，不能返回 null 让面板以为没测');
  assert.match(String(result.code), /ECONNREFUSED|EPROTO|HANDSHAKE_FAILED/);
  assert.ok(Date.now() - started < 3000, '本机端口关闭要立刻返回，不该等满超时');
});

// ── BFL 的连通测试 ──────────────────────────────────────────────────────
// 端点选对是这组测试存在的理由。BFL 上「看起来像探针」的三条路全都不行：
//   /v1/models            → 404，BFL 根本没有列表接口
//   /v1/get_result?id=假  → 404，而且**完全不校验 Key**：乱填的 Key 也回同一个 404，
//                           用它做探针等于给任何 Key 发通行证
//   /v1/credits           → 200 {"credits":N} / 403 / 422，唯一能分辨 Key 好坏的一条
const BFL_DRAFT = { kind: 'bfl', baseUrl: 'https://api.bfl.ai', model: 'flux-pro-1.1', apiKey: 'bfl_test', sizeMode: 'pixels' };

test('BFL 用 /v1/credits 做探针，并把余额一起带回来', async () => {
  const fetchImpl = fakeFetch(async () => textResponse(200, '{"credits": 1000.0}'));
  const probe = createChannelProbe({ fetchImpl });
  const result = await probe(BFL_DRAFT);

  assert.equal(result.ok, true);
  assert.equal(result.probe, 'bfl-credits');
  assert.equal(result.credits, 1000);
  assert.equal(fetchImpl.calls[0].url, 'https://api.bfl.ai/v1/credits');
  // 鉴权只有 x-key 一种；发成 Bearer 会稳定拿到 403。
  assert.equal(fetchImpl.calls[0].init.headers['x-key'], 'bfl_test');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});

test('BFL 不列模型，模型命中数只能如实说「核不了」', async () => {
  const fetchImpl = fakeFetch(async () => textResponse(200, '{"credits": 12.5}'));
  const result = await createChannelProbe({ fetchImpl })(BFL_DRAFT);
  assert.equal(result.modelFound, null, '不能假装命中，否则面板会写「你在列表里」');
  assert.equal(result.modelCount, 0);
});

test('BFL 的 403 和 422 分开报：一个是 Key 不对，一个是 Key 形态就不对', async () => {
  const denied = createChannelProbe({ fetchImpl: fakeFetch(async () => textResponse(403, '{"detail":"Not authenticated"}')) });
  await assert.rejects(() => denied(BFL_DRAFT), (error) => {
    assert.equal(error.code, 'CHANNEL_TEST_FAILED');
    assert.match(error.message, /x-key/, '要告诉用户 BFL 只认 x-key，不然他会一直换 Key');
    return true;
  });

  const malformed = createChannelProbe({ fetchImpl: fakeFetch(async () => textResponse(422, '{"detail":"Invalid API key format"}')) });
  await assert.rejects(() => malformed(BFL_DRAFT), (error) => {
    assert.match(error.message, /格式不对/, '422 说明 Key 抄错了，和 403「这把 Key 不属于这里」不是一回事');
    return true;
  });
});

test('BFL 地址写成 /v1 结尾也能收敛，不会拼出 /v1/v1/credits', async () => {
  const fetchImpl = fakeFetch(async () => textResponse(200, '{"credits": 1}'));
  await createChannelProbe({ fetchImpl })({ ...BFL_DRAFT, baseUrl: 'https://api.bfl.ai/v1' });
  assert.equal(fetchImpl.calls[0].url, 'https://api.bfl.ai/v1/credits');
});

test('BFL 不走 /models：那条路对有效 Key 也是 404', async () => {
  const fetchImpl = fakeFetch(async () => textResponse(200, '{"credits": 1}'));
  await createChannelProbe({ fetchImpl })(BFL_DRAFT);
  assert.ok(!/\/models/.test(fetchImpl.calls[0].url), '打 /models 会得到 404，测出来是假的失败');
});
