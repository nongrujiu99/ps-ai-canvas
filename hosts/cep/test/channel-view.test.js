const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannelView, providerSummary } = require('../js/channel-view');

const IDS = ['workspace-id', 'api-key', 'base-url', 'openai-key', 'openai-model', 'openai-model-custom', 'openai-model-custom-wrap', 'openai-size-mode', 'channel-name', 'save-channel', 'test-channel', 'test-status', 'channel-aliyun-tab', 'channel-openai-tab', 'channel-bfl-tab', 'channel-aliyun', 'channel-openai', 'channel-bfl', 'channel-lock', 'channel-status', 'bfl-key', 'bfl-base-url', 'bfl-model', 'bfl-model-custom', 'bfl-model-custom-wrap', 'bfl-name'];

function fakeDom() {
  const nodes = {};
  for (const id of IDS) nodes[id] = { id, value: '', textContent: '', className: '', placeholder: '', disabled: false, onclick: null };
  return { $: (id) => nodes[id], nodes };
}

function fakeService(overrides = {}) {
  const calls = [];
  const testCalls = [];
  return {
    calls,
    testCalls,
    channel: async () => ({ kind: 'aliyun', locked: false, aliyun: { workspaceId: 'ws_1', hasKey: true }, openai: { baseUrl: '', model: '', sizeMode: 'pixels', hasKey: false } }),
    saveChannel: async (payload) => { calls.push(payload); return { kind: payload.kind, locked: false, aliyun: { workspaceId: 'ws_1', hasKey: true }, openai: { baseUrl: payload.baseUrl || '', model: payload.model || '', name: payload.name || '', sizeMode: payload.sizeMode || 'pixels', hasKey: true } }; },
    testChannel: async (payload) => { testCalls.push(payload); return { ok: true, model: payload.model, modelFound: true, modelCount: 12, similar: [], latencyMs: 9 }; },
    ...overrides
  };
}

test('renders the saved channel and fills the matching fields', async () => {
  const dom = fakeDom();
  const view = createChannelView({ $: dom.$, service: fakeService() });
  view.bind();
  await view.load();

  assert.equal(dom.nodes['channel-aliyun-tab'].className, 'seg active');
  assert.equal(dom.nodes['channel-openai-tab'].className, 'seg');
  assert.equal(dom.nodes['channel-aliyun'].className, 'channel-body');
  assert.equal(dom.nodes['channel-openai'].className, 'channel-body hidden');
  assert.equal(dom.nodes['workspace-id'].value, 'ws_1');
  assert.equal(dom.nodes['api-key'].value, '');
  assert.match(dom.nodes['api-key'].placeholder, /已保存/);
  assert.match(dom.nodes['channel-status'].textContent, /百炼/);
});

test('switching tab only toggles visibility, it does not silently submit', async () => {
  const dom = fakeDom();
  const service = fakeService();
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  dom.nodes['channel-openai-tab'].onclick();
  assert.equal(view.state.kind, 'openai');
  assert.equal(dom.nodes['channel-openai-tab'].className, 'seg active');
  assert.equal(dom.nodes['channel-openai'].className, 'channel-body');
  assert.equal(dom.nodes['channel-aliyun'].className, 'channel-body hidden');
  assert.equal(service.calls.length, 0);
});

test('saving the third-party channel posts the fields the user typed', async () => {
  const dom = fakeDom();
  const service = fakeService();
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://api.example.com/v1';
  dom.nodes['openai-key'].value = 'sk-test';
  dom.nodes['openai-model'].value = 'gpt-image-2.6-flare';
  dom.nodes['openai-size-mode'].value = 'tier';

  await view.save();
  assert.deepEqual(service.calls[0], { kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-image-2.6-flare', name: '', sizeMode: 'tier' });
  assert.match(dom.nodes['channel-status'].textContent, /已保存/);
  assert.equal(dom.nodes['channel-status'].className, 'status ok');
});

test('a channel pinned by the config file is disabled and refuses to save', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => ({ kind: 'openai', locked: true, lockedNote: '渠道由 openai.env 固定', aliyun: { workspaceId: '', hasKey: false }, openai: { baseUrl: 'https://pinned/v1', model: 'gpt-image-2', sizeMode: 'pixels', hasKey: true } })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  assert.equal(dom.nodes['channel-lock'].className, 'lock');
  assert.equal(dom.nodes['channel-lock'].textContent, '渠道由 openai.env 固定');
  for (const id of ['workspace-id', 'api-key', 'base-url', 'openai-key', 'openai-model', 'openai-size-mode', 'save-channel']) {
    assert.equal(dom.nodes[id].disabled, true, id + ' 应该被禁用');
  }

  await view.save();
  assert.equal(service.calls.length, 0, '锁定状态下不应发出保存请求');
  assert.equal(dom.nodes['channel-status'].className, 'status error');
});

test('a failed save surfaces the server message instead of a generic error', async () => {
  const dom = fakeDom();
  const service = fakeService({
    saveChannel: async () => { const error = new Error('服务地址需要以 http:// 或 https:// 开头。'); error.code = 'INVALID_CHANNEL'; throw error; }
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'api.example.com';

  await view.save();
  assert.equal(dom.nodes['channel-status'].textContent, '服务地址需要以 http:// 或 https:// 开头。');
  assert.equal(dom.nodes['channel-status'].className, 'status error');
});

// 顶部状态条的三档颜色决定用户第一眼怎么理解「能不能用」。
// 判错会出现「显示已连接、点了生成才报没 Key」这种最伤人的情况。
test('provider summary marks a fully configured third-party channel as ready', () => {
  const info = providerSummary({ kind: 'openai', locked: false, openai: { baseUrl: 'https://ai.example.com/v1', model: 'gpt-image-2.6-flare', hasKey: true } });
  assert.equal(info.tone, 'ok');
  assert.match(info.text, /gpt-image-2\.6-flare/);
});

test('provider summary warns instead of claiming ready when a field is missing', () => {
  const noKey = providerSummary({ kind: 'openai', openai: { baseUrl: 'https://ai.example.com/v1', model: 'm', hasKey: false } });
  assert.equal(noKey.tone, 'warn');
  assert.match(noKey.text, /API Key/);

  const noModel = providerSummary({ kind: 'openai', openai: { baseUrl: 'https://ai.example.com/v1', model: '', hasKey: true } });
  assert.equal(noModel.tone, 'warn');
  assert.match(noModel.text, /模型/);

  const noWorkspace = providerSummary({ kind: 'aliyun', aliyun: { workspaceId: '', hasKey: true } });
  assert.equal(noWorkspace.tone, 'warn');
  assert.match(noWorkspace.text, /业务空间/);
});

test('provider summary names the locked state so the user stops looking for the switch', () => {
  const info = providerSummary({ kind: 'aliyun', locked: true, aliyun: { workspaceId: 'ws_1', hasKey: true } });
  assert.equal(info.tone, 'ok');
  assert.match(info.text, /已锁定/);
});

// 模型下拉只放实测跑通的模型。列一个没验证过的名字，等于承诺「选它一定行」，
// 而渠道根本没这个模型时要等到上传完底稿才报错，用户白等一分钟。
test('the model picker only offers models that were actually verified', async () => {
  const dom = fakeDom();
  const view = createChannelView({ $: dom.$, service: fakeService() });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();

  const html = dom.nodes['openai-model'].innerHTML;
  assert.match(html, /gemini-3\.1-flash-image/);
  assert.match(html, /nano-banana-pro/);
  assert.match(html, /gpt-image-2\.6-flare/);
  assert.doesNotMatch(html, /gemini-3-pro-image/, '没实测过的模型不该出现在清单里');
  assert.doesNotMatch(html, /-(2k|4k)"/, '-2k/-4k 是固定分辨率，会无视我们发的档位');
  assert.match(html, /自定义/);
  assert.equal(dom.nodes['openai-model'].value, 'gemini-3.1-flash-image', '没配过时默认选推荐项');
});

// 选错尺寸模式不会报错，只会让渠道按自己的默认比例重排画面，所以必须联动。
test('picking a model also fixes the size mode', async () => {
  const dom = fakeDom();
  const view = createChannelView({ $: dom.$, service: fakeService() });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();

  dom.nodes['openai-model'].value = 'gpt-image-2.6-flare';
  dom.nodes['openai-model'].onchange();
  assert.equal(dom.nodes['openai-size-mode'].value, 'pixels');
  assert.equal(dom.nodes['channel-status'].className, 'status ok');

  dom.nodes['openai-model'].value = 'gemini-3.1-flash-image';
  dom.nodes['openai-model'].onchange();
  assert.equal(dom.nodes['openai-size-mode'].value, 'tier');
});

test('a saved model outside the verified list falls back to the custom field', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => ({ kind: 'openai', locked: false, aliyun: { workspaceId: '', hasKey: false }, openai: { baseUrl: 'https://ai.example.com/v1', model: 'some-vendor-image-2', sizeMode: 'pixels', hasKey: true } })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  assert.equal(dom.nodes['openai-model'].value, '__custom__');
  assert.equal(dom.nodes['openai-model-custom'].value, 'some-vendor-image-2');
  assert.equal(dom.nodes['openai-model-custom-wrap'].className, '', '自定义输入框要显示出来');

  await view.save();
  assert.equal(service.calls[0].model, 'some-vendor-image-2', '保存时提交手填的名字');
});

// 测试按钮的价值在于「不用先保存也能验」：Key 是刚敲进去的，还没进凭据库。
test('the test button probes with what is typed, including an unsaved key', async () => {
  const dom = fakeDom();
  const service = fakeService();
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://ai.example.com/v1';
  dom.nodes['openai-key'].value = 'sk-just-typed';
  dom.nodes['openai-model'].value = 'gemini-3.1-flash-image';

  await view.test();
  // name 只是显示层字段，探针拿到也不会用（服务端 resolveDraft 只取地址/Key/模型/尺寸模式），
  // 但 payload() 是唯一出口，所以连它一起比——多一个字段就说明有人改了公共出口。
  assert.deepEqual(service.testCalls[0], { kind: 'openai', baseUrl: 'https://ai.example.com/v1', apiKey: 'sk-just-typed', model: 'gemini-3.1-flash-image', name: '', sizeMode: 'tier' });
  assert.equal(service.calls.length, 0, '测试不应该保存');
  assert.match(dom.nodes['test-status'].textContent, /连通正常/);
  assert.match(dom.nodes['test-status'].textContent, /余额/, '别让「连通正常」听起来像可以出图');
  assert.equal(dom.nodes['test-status'].className, 'status ok');
});

test('a miss keeps the key but says the model name is the problem', async () => {
  const dom = fakeDom();
  const service = fakeService({
    testChannel: async () => ({ ok: true, model: 'gemini-3-pro-image', modelFound: false, modelCount: 31, similar: ['gemini-3.1-flash-image'], latencyMs: 40 })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://ai.example.com/v1';
  dom.nodes['openai-model-custom-wrap'].className = '';

  dom.nodes['openai-model'].value = '__custom__';
  dom.nodes['openai-model-custom'].value = 'gemini-3-pro-image';
  await view.test();

  assert.equal(dom.nodes['test-status'].className, 'status warn');
  assert.match(dom.nodes['test-status'].textContent, /没有/);
  assert.match(dom.nodes['test-status'].textContent, /gemini-3\.1-flash-image/, '要给出渠道里真实存在的候选');
});

test('a failed test shows the server message instead of a generic error', async () => {
  const dom = fakeDom();
  const service = fakeService({
    testChannel: async () => { const error = new Error('Key 被拒绝（HTTP 401）：这个 Key 不对。'); error.code = 'CHANNEL_TEST_FAILED'; throw error; }
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://ai.example.com/v1';

  await view.test();
  assert.equal(dom.nodes['test-status'].className, 'status error');
  assert.match(dom.nodes['test-status'].textContent, /401/);
});

test('the test button refuses to fire without an address or a model', async () => {
  const dom = fakeDom();
  const service = fakeService();
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();

  await view.test();
  assert.equal(dom.nodes['test-status'].textContent, '请先填写服务地址。');
  assert.equal(service.testCalls.length, 0);
});

// ── Vertex AI（Express Mode）────────────────────────────────────────────────
// Vertex 的模型名和普通中转站完全不通用，地址一换清单就得跟着换；而且
// Express Mode 不给列模型，清单只能内置——规范点名的那个必须在里面。
test('a vertex address swaps in the built-in vertex model presets', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => ({ kind: 'openai', locked: false, aliyun: { workspaceId: '', hasKey: false }, openai: { baseUrl: '', model: '', sizeMode: 'tier', hasKey: false } })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();

  dom.nodes['base-url'].value = 'https://aiplatform.googleapis.com/v1';
  dom.nodes['base-url'].onchange();

  const html = dom.nodes['openai-model'].innerHTML;
  assert.match(html, /gemini-3\.1-flash-image/, 'Vertex 生图模型要内置');
  assert.equal(dom.nodes['openai-model'].value, 'gemini-3.1-flash-image', '切到 Vertex 后默认选主力模型');
  // 昵称不是模型 ID：gemini-nano-banana-2.1 在 Vertex 上是 404 NOT_FOUND，
  // 列进下拉只会让人选中一个必然失败的模型。
  assert.doesNotMatch(html, /gemini-nano-banana/, '不能把产品昵称当成模型 ID 列出来');
  assert.match(html, /Nano Banana/, '昵称要留在 label 里，否则认不出是哪张图');
  assert.match(dom.nodes['channel-status'].textContent, /Vertex/);
  assert.equal(dom.nodes['openai-size-mode'].value, 'tier');
});

test('a saved vertex channel loads with its own presets, not the relay list', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => ({
      kind: 'openai',
      locked: false,
      aliyun: { workspaceId: '', hasKey: false },
      openai: { baseUrl: 'https://aiplatform.googleapis.com/v1', protocol: 'vertex', model: 'gemini-3-pro-image', sizeMode: 'tier', hasKey: true }
    })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  assert.equal(dom.nodes['openai-model'].value, 'gemini-3-pro-image');
  assert.doesNotMatch(dom.nodes['openai-model'].innerHTML, /gpt-image-2\.6-flare/, 'Vertex 上这些名字必然 404');
});

// 探针验的是「地址 + Key」，跟下拉里选哪个模型无关，所以没选模型也该能测。
test('a vertex channel can be tested before a model is picked', async () => {
  const dom = fakeDom();
  const probed = [];
  const service = fakeService({
    testChannel: async (payload) => {
      probed.push(payload);
      return { ok: true, status: 200, model: '', modelFound: null, modelCount: 0, similar: [], latencyMs: 120, probe: 'vertex-generate-content', probeModel: 'gemini-3.5-flash-lite' };
    }
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://aiplatform.googleapis.com/v1';
  dom.nodes['openai-key'].value = 'AQ.typed';
  dom.nodes['openai-model'].value = '';

  await view.test();
  assert.equal(probed.length, 1, 'Vertex 的探针不依赖模型名');
  assert.equal(dom.nodes['test-status'].className, 'status ok');
  assert.match(dom.nodes['test-status'].textContent, /Vertex/);
  assert.match(dom.nodes['test-status'].textContent, /gemini-3\.5-flash-lite/, '要说清用哪条请求验的');
  assert.match(dom.nodes['test-status'].textContent, /核不了/, '别让探针通过听起来像模型名也验证过');
});

// 顶部那一行要拆成「固定类别 + 会变的半截」。拆不开就只能把两者用同一个字色
// 连成一串长句——用户既看不出主次，状态色也没地方落。
test('provider summary splits the fixed label from the changing part', () => {
  const ok = providerSummary({ kind: 'openai', locked: false, openai: { baseUrl: 'https://ai.example.com/v1', model: 'gemini-3.1-flash-image', hasKey: true } });
  assert.equal(ok.label, '第三方 API');
  assert.equal(ok.detail, 'gemini-3.1-flash-image');
  assert.equal(ok.text, '第三方 API · gemini-3.1-flash-image', 'text 是给 tooltip 用的，仍要能拼回去');

  const warn = providerSummary({ kind: 'openai', openai: { baseUrl: 'https://ai.example.com/v1', model: 'm', hasKey: false } });
  assert.equal(warn.label, '第三方 API');
  assert.match(warn.detail, /API Key/);

  const offline = providerSummary(null);
  assert.match(offline.label, /本地服务/);
  assert.equal(offline.tone, 'error');
  assert.ok(offline.detail.length > 0, 'detail 不能空，否则胶囊是个空格子');

  // 胶囊里放的是「会变的那半截」，不是整句话——否则等于把长句又搬回一行。
  for (const info of [ok, warn, offline]) assert.ok(!info.detail.includes(' · '), 'detail 里不该再带分隔点：' + info.detail);
});

// 「第三方 API」只是默认称呼。用户给中转站起了名字，顶部那一行就該叫那个名字；
// 名字不该因为「还没填完 Key」就退回默认值——那样用户会以为自己的设置丢了。
test('provider summary uses the display name the user typed', () => {
  const named = providerSummary({ kind: 'openai', locked: false, openai: { name: '我的中转站', baseUrl: 'https://x.example.com/v1', model: 'gemini-3.1-flash-image', hasKey: true } });
  assert.equal(named.label, '我的中转站');
  assert.equal(named.detail, 'gemini-3.1-flash-image');

  const warn = providerSummary({ kind: 'openai', openai: { name: '我的中转站', baseUrl: '', model: 'm', hasKey: true } });
  assert.equal(warn.label, '我的中转站');

  const blank = providerSummary({ kind: 'openai', openai: { name: '   ', baseUrl: 'https://x.example.com/v1', model: 'm', hasKey: true } });
  assert.equal(blank.label, '第三方 API', '只有空白时回落默认称呼');
});

test('the display name is filled back into the form and echoed in the status line', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => ({
      kind: 'openai', locked: false, aliyun: {},
      openai: { name: '我的中转站', baseUrl: 'https://x.example.com/v1', model: 'gemini-3.1-flash-image', sizeMode: 'tier', hasKey: true, protocol: 'openai' }
    })
  });
  const view = createChannelView({ $: dom.$, service });
  await view.load();

  assert.equal(dom.nodes['channel-name'].value, '我的中转站');
  assert.match(dom.nodes['channel-status'].textContent, /我的中转站/, '「正在使用…」要用同一个称呼');
});

test('saving posts the display name along with the rest of the fields', async () => {
  const dom = fakeDom();
  const service = fakeService();
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://x.example.com/v1';
  dom.nodes['openai-key'].value = 'sk-1';
  dom.nodes['openai-model'].value = 'gemini-3.1-flash-image';
  dom.nodes['channel-name'].value = '  我的中转站  ';
  await view.save();

  assert.equal(service.calls.at(-1).name, '我的中转站', '前后空格要在这里 trim，别指望服务端兜');
});

// 设置页那个「第三方 API」按钮和「显示名称」是同一件事的两个落点。只改顶部渠道行、
// 不改这个按钮，用户填完名字保存后还会看见旧的默认称呼，以为没存上。
test('the channel tab follows the display name, not the hardcoded default', async () => {
  const dom = fakeDom();
  const service = fakeService();
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  assert.equal(dom.nodes['channel-openai-tab'].textContent, '第三方 API', '没填名字时仍是默认称呼');

  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://x.example.com/v1';
  dom.nodes['openai-key'].value = 'sk-1';
  dom.nodes['openai-model'].value = 'gemini-3.1-flash-image';
  dom.nodes['channel-name'].value = '  我的中转站  ';
  await view.save();
  assert.equal(dom.nodes['channel-openai-tab'].textContent, '我的中转站', '保存后按钮立刻改名');

  // 清空名字要回到默认称呼，不能停在上一个名字上。
  dom.nodes['channel-name'].value = '';
  await view.save();
  assert.equal(dom.nodes['channel-openai-tab'].textContent, '第三方 API');

  // 固定类别（OpenAI 兼容协议）收进 title，改成自定义名字后仍然看得出这是哪条通道。
  dom.nodes['channel-name'].value = '我的中转站';
  await view.save();
  assert.match(dom.nodes['channel-openai-tab'].title, /OpenAI 兼容协议/);
  assert.match(dom.nodes['channel-openai-tab'].title, /我的中转站/);
});

// 握手分段真的显示出来：总 latencyMs 分不清「Google 排队」和「这条线本身慢」。
test('the test status shows the handshake breakdown when the server measured it', async () => {
  const dom = fakeDom();
  const service = fakeService({
    testChannel: async () => ({
      ok: true, status: 200, model: '', modelFound: null, modelCount: 0, similar: [], latencyMs: 1414,
      probe: 'vertex-generate-content', probeModel: 'gemini-3.5-flash-lite',
      handshake: { dnsMs: 1438, tcpMs: 1892, tlsMs: 3330 }
    })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://aiplatform.googleapis.com/v1';
  dom.nodes['openai-key'].value = 'AQ.typed';
  dom.nodes['openai-model'].value = '';

  await view.test();
  const text = dom.nodes['test-status'].textContent;
  assert.match(text, /DNS 1\.4 秒/);
  assert.match(text, /TLS 3\.3 秒/);
  assert.match(text, /线路偏慢/, 'TLS 三秒多的线路要直接说慢，别让人以为出图慢是模型的问题');
});

test('a handshake that failed on its own does not fabricate timings', async () => {
  const dom = fakeDom();
  const service = fakeService({
    testChannel: async () => ({
      ok: true, status: 200, model: 'gemini-3.1-flash-image', modelFound: true, modelCount: 12, similar: [], latencyMs: 300,
      handshake: { dnsMs: null, tcpMs: null, tlsMs: null, code: 'ECONNRESET' }
    })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  dom.nodes['channel-openai-tab'].onclick();
  dom.nodes['base-url'].value = 'https://ai.example.com/v1';
  dom.nodes['openai-key'].value = 'sk-1';
  dom.nodes['openai-model'].value = 'gemini-3.1-flash-image';

  await view.test();
  const text = dom.nodes['test-status'].textContent;
  assert.match(text, /握手失败（ECONNRESET）/);
  assert.doesNotMatch(text, /undefined|NaN/, '拿不到分段就别写数字');
});

// ── BFL 作为第三个渠道 ────────────────────────────────────────────────────
// 用户最在意的一条：换到 BFL 不能把已经配好的 Gemini 冲掉。
// 前端这层的责任是「payload 不夹带别家字段」「tab 与状态行跟着走」，其余的由服务端测试守。
const BFL_VIEW = {
  kind: 'bfl',
  locked: false,
  aliyun: { workspaceId: 'ws_1', hasKey: true },
  openai: { baseUrl: 'https://aiplatform.googleapis.com/v1', protocol: 'vertex', model: 'gemini-3.1-flash-image', name: 'Gemini', sizeMode: 'tier', hasKey: true },
  bfl: { baseUrl: 'https://api.bfl.ai', model: 'flux-pro-1.1', name: 'FLUX', hasKey: true }
};

test('切到 BFL 只换显示，不动已经填好的第三方字段', async () => {
  const dom = fakeDom();
  const view = createChannelView({ $: dom.$, service: fakeService({ channel: async () => BFL_VIEW }) });
  view.bind();
  await view.load();

  assert.equal(dom.nodes['channel-bfl-tab'].className, 'seg active');
  assert.equal(dom.nodes['channel-openai-tab'].className, 'seg');
  assert.equal(dom.nodes['channel-bfl'].className, 'channel-body');
  assert.equal(dom.nodes['channel-openai'].className, 'channel-body hidden');
  // Gemini 那套还在表单里，没被清空
  assert.equal(dom.nodes['base-url'].value, 'https://aiplatform.googleapis.com/v1');
  assert.equal(dom.nodes['bfl-model'].value, 'flux-pro-1.1');
});

test('BFL 保存只提交自己的四个字段，不夹带别家的', async () => {
  const dom = fakeDom();
  const service = fakeService({ channel: async () => BFL_VIEW });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  dom.nodes['bfl-model'].value = 'flux-2-pro-preview';
  dom.nodes['bfl-key'].value = 'bfl_typed';
  dom.nodes['bfl-name'].value = 'FLUX 2';
  await view.save();

  const sent = service.calls.at(-1);
  assert.equal(sent.kind, 'bfl');
  assert.equal(sent.model, 'flux-2-pro-preview');
  assert.equal(sent.apiKey, 'bfl_typed');
  assert.equal(sent.name, 'FLUX 2');
  // 地址留空表示「用官方」，不该在面板里补一份写死的副本
  assert.equal(sent.baseUrl, '');
  assert.equal(sent.workspaceId, undefined, 'BFL 没有业务空间这个概念');
  assert.equal(sent.sizeMode, undefined, 'BFL 直接收 width/height，没有档位这一层');
});

test('BFL 的地址和模型都能留空，照样允许测试连通', async () => {
  const dom = fakeDom();
  const service = fakeService({ channel: async () => BFL_VIEW });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();

  dom.nodes['bfl-base-url'].value = '';
  dom.nodes['bfl-model'].value = '';
  await view.test();

  assert.equal(service.testCalls.length, 1, '官方域名 + 内置默认模型，没必要拦');
  assert.equal(service.testCalls[0].kind, 'bfl');
});

test('BFL 的探针结果带余额：这是唯一能在生成前发现「没钱了」的地方', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => BFL_VIEW,
    testChannel: async () => ({ ok: true, status: 200, probe: 'bfl-credits', credits: 1000, modelFound: null, modelCount: 0, similar: [], latencyMs: 820 })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  await view.test();

  const text = dom.nodes['test-status'].textContent;
  assert.match(text, /1000 credits/);
  assert.match(text, /不提供模型列表/, '不能让人以为模型名也核过了');
});

test('余额为 0 时要说是余额问题，不是 Key 问题', async () => {
  const dom = fakeDom();
  const service = fakeService({
    channel: async () => BFL_VIEW,
    testChannel: async () => ({ ok: true, status: 200, probe: 'bfl-credits', credits: 0, modelFound: null, modelCount: 0, similar: [], latencyMs: 300 })
  });
  const view = createChannelView({ $: dom.$, service });
  view.bind();
  await view.load();
  await view.test();

  const node = dom.nodes['test-status'];
  assert.equal(node.className, 'status warn');
  assert.match(node.textContent, /余额是 0/);
  assert.doesNotMatch(node.textContent, /Key 不对/, 'Key 是有效的，说成 Key 问题会让人白换一把');
});

test('顶部渠道行读 BFL 的名字和模型，模型留空时显示默认值', () => {
  const named = providerSummary(BFL_VIEW);
  assert.equal(named.label, 'FLUX');
  assert.equal(named.detail, 'flux-pro-1.1');
  assert.equal(named.tone, 'ok');

  const blank = providerSummary({ ...BFL_VIEW, bfl: { baseUrl: 'https://api.bfl.ai', model: '', name: '', hasKey: true } });
  assert.equal(blank.detail, 'flux-pro-1.1', '留空就是走内置默认，显示「未填模型」会和实际行为矛盾');

  const noKey = providerSummary({ ...BFL_VIEW, bfl: { baseUrl: '', model: '', name: '', hasKey: false } });
  assert.equal(noKey.tone, 'warn');
  assert.match(noKey.detail, /API Key/);
});
