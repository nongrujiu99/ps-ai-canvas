const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannelStore, fromEnv, isOpenAiAlias } = require('../src/channel-store');

function fakeStore(initial = null) {
  let value = initial;
  return {
    read: async () => value,
    save: async (next) => { value = next; },
    clear: async () => { value = null; },
    peek: () => value
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-channel-'));
}

const OPENAI = { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-image-2', apiKey: 'sk-third-party' };

test('defaults to 百炼 when nothing has been saved', async () => {
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore() });
  const view = await store.describe();
  assert.equal(view.kind, 'aliyun');
  assert.equal(view.locked, false);
  assert.equal(view.aliyun.hasKey, false);
  assert.equal((await store.resolve()).kind, 'aliyun');
});

test('switching to a third-party channel takes effect immediately without restarting', async () => {
  const dir = tempDir();
  const aliyun = fakeStore();
  const openai = fakeStore();
  const store = createChannelStore({ dir, aliyun, openai });

  await store.save(OPENAI);
  const resolved = await store.resolve();
  assert.equal(resolved.kind, 'openai');
  assert.equal(resolved.baseUrl, OPENAI.baseUrl);
  assert.equal(resolved.model, OPENAI.model);
  assert.equal(resolved.apiKey, 'sk-third-party');
  assert.equal(openai.peek().apiKey, 'sk-third-party');
  assert.equal(aliyun.peek(), null);

  // 切回百炼
  await store.save({ kind: 'aliyun', workspaceId: 'ws_456', apiKey: 'bailian-key' });
  const back = await store.resolve();
  assert.equal(back.kind, 'aliyun');
  assert.equal(back.workspaceId, 'ws_456');
  assert.equal(back.apiKey, 'bailian-key');
});

test('the API key never lands in channel.json', async () => {
  const dir = tempDir();
  const openai = fakeStore();
  const store = createChannelStore({ dir, aliyun: fakeStore(), openai });
  await store.save(OPENAI);
  const raw = fs.readFileSync(path.join(dir, 'channel.json'), 'utf8');
  assert.equal(raw.includes('sk-third-party'), false);
  assert.equal(raw.includes('https://api.example.com/v1'), true);
});

test('editing the URL or model alone keeps the stored key', async () => {
  const openai = fakeStore({ apiKey: 'sk-existing', workspaceId: 'api.example.com' });
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai });
  await store.save({ kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-image-2.6-flare' });
  const resolved = await store.resolve();
  assert.equal(resolved.apiKey, 'sk-existing');
  assert.equal(resolved.model, 'gpt-image-2.6-flare');
});

test('editing from the panel does not reset the pixel ceiling', async () => {
  // 面板 UI 没有 maxPixels 字段。改模型时如果不沿用旧值，4K 画布会被悄悄降采样。
  const dir = tempDir();
  const store = createChannelStore({ dir, aliyun: fakeStore(), openai: fakeStore() });
  await store.save({ kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'a', apiKey: 'sk-1', maxPixels: 16777216 });
  assert.equal((await store.resolve()).maxPixels, 16777216);
  await store.save({ kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'b' });
  assert.equal((await store.resolve()).maxPixels, 16777216);
  assert.equal((await store.resolve()).model, 'b');
});

test('invalid channel input is rejected with a readable reason', async () => {
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore() });
  await assert.rejects(() => store.save({ kind: 'openai', baseUrl: 'api.example.com', model: 'x', apiKey: 'k' }), (error) => error.code === 'INVALID_CHANNEL');
  await assert.rejects(() => store.save({ kind: 'openai', baseUrl: 'https://a.com/v1', model: '', apiKey: 'k' }), (error) => error.code === 'INVALID_CHANNEL' && /模型/.test(error.message));
  await assert.rejects(() => store.save({ kind: 'openai', baseUrl: 'https://a.com/v1', model: 'm' }), (error) => error.code === 'INVALID_CHANNEL' && /API Key/.test(error.message));
  await assert.rejects(() => store.save({ kind: 'aliyun', workspaceId: 'has space', apiKey: 'k' }), (error) => error.code === 'INVALID_CHANNEL');
});

test('a channel pinned by the environment file is read-only from the panel', async () => {
  const env = { STUDIO_PROVIDER: 'openai', STUDIO_LOCK_PROVIDER: '1', STUDIO_BASE_URL: 'https://pinned.example.com/v1', STUDIO_API_KEY: 'sk-env', STUDIO_MODEL: 'gpt-image-2.6-flare' };
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore(), env });
  const view = await store.describe();
  assert.equal(view.locked, true);
  assert.equal(view.kind, 'openai');
  assert.equal(view.openai.baseUrl, 'https://pinned.example.com/v1');
  assert.equal(view.openai.hasKey, true);
  assert.equal(view.lockedNote.length > 0, true);

  const resolved = await store.resolve();
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.apiKey, 'sk-env');

  await assert.rejects(() => store.save(OPENAI), (error) => error.code === 'CHANNEL_LOCKED');
});

test('provider aliases from the environment file are recognised', () => {
  for (const value of ['openai', 'openai-compat', 'compat', 'thirdparty', 'third-party', ' OpenAI ']) {
    assert.equal(isOpenAiAlias(value), true, value);
  }
  for (const value of ['', 'aliyun', 'bailian', undefined]) {
    assert.equal(isOpenAiAlias(value), false, String(value));
  }
  assert.equal(fromEnv({ STUDIO_PROVIDER: 'aliyun' }), null);
  assert.equal(fromEnv({ STUDIO_PROVIDER: 'openai', STUDIO_BASE_URL: 'https://a.com/v1' }).baseUrl, 'https://a.com/v1');
});

test('STUDIO_PROVIDER alone is a default, not a lock', async () => {
  // start-openai.js 会自动补 STUDIO_PROVIDER=openai。如果它等于「锁定」，
  // 面板里的渠道设置就永远改不动了——这里把这个行为钉死。
  const env = { STUDIO_PROVIDER: 'openai', STUDIO_BASE_URL: 'https://env.example.com/v1', STUDIO_API_KEY: 'sk-env', STUDIO_MODEL: 'env-model' };
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore(), env });

  const initial = await store.describe();
  assert.equal(initial.locked, false);
  assert.equal(initial.kind, 'openai');
  assert.equal(initial.openai.baseUrl, 'https://env.example.com/v1');

  await store.save(OPENAI);
  const after = await store.describe();
  assert.equal(after.locked, false);
  assert.equal(after.openai.baseUrl, OPENAI.baseUrl);
  assert.equal((await store.resolve()).source, 'panel');
});

test('a corrupt channel.json falls back to 百炼 instead of breaking the panel', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'channel.json'), '{not json', 'utf8');
  const store = createChannelStore({ dir, aliyun: fakeStore(), openai: fakeStore() });
  const view = await store.describe();
  assert.equal(view.kind, 'aliyun');
  // 仍然可以正常保存，覆盖掉坏文件
  await store.save(OPENAI);
  assert.equal((await store.describe()).kind, 'openai');
});

// 连通测试用的是「草稿」：面板里刚敲进去的值，可能还没保存。
// 它绝不能顺手把东西写盘——用户点「测试」只是想确认填对了没有。
test('resolveDraft builds a testable draft from unsaved panel input', async () => {
  const dir = tempDir();
  const openai = fakeStore();
  const store = createChannelStore({ dir, aliyun: fakeStore(), openai });

  const draft = await store.resolveDraft({ kind: 'openai', baseUrl: 'https://ai.example.com/v1', apiKey: 'sk-typed', model: 'gemini-3.1-flash-image', sizeMode: 'tier' });
  assert.deepEqual(draft, { kind: 'openai', baseUrl: 'https://ai.example.com/v1', model: 'gemini-3.1-flash-image', apiKey: 'sk-typed', sizeMode: 'tier' });
  assert.equal(openai.peek(), null, '测试不应该写凭据库');
  assert.equal(fs.existsSync(path.join(dir, 'channel.json')), false, '测试不应该写 channel.json');
});

test('resolveDraft reuses the saved key when the panel leaves it blank', async () => {
  const dir = tempDir();
  const openai = fakeStore();
  const store = createChannelStore({ dir, aliyun: fakeStore(), openai });
  await store.save(OPENAI);

  const draft = await store.resolveDraft({ kind: 'openai', baseUrl: OPENAI.baseUrl, model: 'gemini-3.1-flash-image', apiKey: '' });
  assert.equal(draft.apiKey, 'sk-third-party');
  assert.equal(draft.model, 'gemini-3.1-flash-image');
});

test('resolveDraft refuses incomplete input with a message the panel can show', async () => {
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore() });
  await assert.rejects(store.resolveDraft({ kind: 'openai', baseUrl: 'api.example.com', model: 'm', apiKey: 'k' }), /http/);
  await assert.rejects(store.resolveDraft({ kind: 'openai', baseUrl: 'https://ai.example.com/v1', model: '', apiKey: 'k' }), /模型/);
  await assert.rejects(store.resolveDraft({ kind: 'openai', baseUrl: 'https://ai.example.com/v1', model: 'm', apiKey: '' }), /API Key/);
  await assert.rejects(store.resolveDraft({ kind: 'aliyun', apiKey: 'k' }), /第三方/);
});

// 面板顶部那一行左边显示的就是这个名字。它纯属显示层——写错不影响任何请求，
// 所以不做「像不像名字」的校验，但必须做两件：去掉换行（会撑破单行胶囊）、截断。
test('the channel display name is stored, trimmed and reflected back to the panel', async () => {
  const dir = tempDir();
  const store = createChannelStore({ dir, aliyun: fakeStore(), openai: fakeStore() });

  await store.save({ ...OPENAI, name: '  我的中转站  ' });
  assert.equal((await store.describe()).openai.name, '我的中转站');
  assert.equal((await store.resolve()).name, '我的中转站');

  // 留空 = 回落成默认的「第三方 API」，由面板决定文案，服务端只回空串
  await store.save({ ...OPENAI, name: '   ' });
  assert.equal((await store.describe()).openai.name, '');

  // 换行/制表符会撑破一行高度的胶囊，统一压成空格
  await store.save({ ...OPENAI, name: 'a\nb\tc' });
  assert.equal((await store.describe()).openai.name, 'a b c');

  // 24 字上限：再长就截断，避免把顶部一整行挤满
  await store.save({ ...OPENAI, name: 'x'.repeat(40) });
  assert.equal((await store.describe()).openai.name.length, 24);
});

// ── BFL 作为第三种渠道 ────────────────────────────────────────────────────
// 用户换渠道最怕的是「换一家就把上一家冲掉了」。channel.json 里三块各存各的、
// Key 各用各的凭据槽，这条必须用测试钉住：它比任何文案都重要。
test('三个渠道各存各的，切到 BFL 不会冲掉第三方和百炼', async () => {
  const dir = tempDir();
  const aliyun = fakeStore();
  const openai = fakeStore();
  const bfl = fakeStore();
  const store = createChannelStore({ dir, aliyun, openai, bfl });

  await store.save({ kind: 'aliyun', workspaceId: 'ws-1', apiKey: 'bailian-key' });
  await store.save({ kind: 'openai', baseUrl: 'https://relay.example.com/v1', model: 'gpt-image-2', apiKey: 'sk-x', name: '中转站' });
  await store.save({ kind: 'bfl', apiKey: 'bfl-key', model: 'flux-2-pro-preview', name: 'FLUX' });

  // 三把 Key 各自待在独立的凭据槽里，谁也不覆盖谁
  assert.equal(aliyun.peek().apiKey, 'bailian-key');
  assert.equal(openai.peek().apiKey, 'sk-x');
  assert.equal(bfl.peek().apiKey, 'bfl-key');

  // 切回第三方：地址、模型、名称原样还在，BFL 那块也没被清掉
  await store.save({ kind: 'openai', baseUrl: 'https://relay.example.com/v1', model: 'gpt-image-2', apiKey: '', name: '中转站' });
  const view = await store.describe();
  assert.equal(view.kind, 'openai');
  assert.equal(view.openai.baseUrl, 'https://relay.example.com/v1');
  assert.equal(view.openai.model, 'gpt-image-2');
  assert.equal(view.openai.name, '中转站');
  assert.equal(view.bfl.baseUrl, 'https://api.bfl.ai');
  assert.equal(view.bfl.model, 'flux-2-pro-preview');
  assert.equal(view.bfl.hasKey, true);
  assert.equal(view.aliyun.workspaceId, 'ws-1');

  // 切回百炼，另外两块仍然在
  await store.save({ kind: 'aliyun', workspaceId: 'ws-1', apiKey: '', name: '' });
  const back = await store.describe();
  assert.equal(back.kind, 'aliyun');
  assert.equal(back.openai.baseUrl, 'https://relay.example.com/v1');
  assert.equal(back.bfl.model, 'flux-2-pro-preview');
});

test('BFL 的地址可以留空，回落到官方域名；模型留空交给适配器默认值', async () => {
  const bfl = fakeStore();
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore(), bfl });
  const view = await store.save({ kind: 'bfl', apiKey: 'bfl-key' });
  assert.equal(view.kind, 'bfl');
  assert.equal(view.bfl.baseUrl, 'https://api.bfl.ai');
  assert.equal(view.bfl.model, '');

  const resolved = await store.resolve();
  assert.equal(resolved.kind, 'bfl');
  assert.equal(resolved.apiKey, 'bfl-key');
  assert.equal(resolved.baseUrl, 'https://api.bfl.ai');
});

test('BFL 没有 Key 时明确报错，而不是保存成功却在生成时才炸', async () => {
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore(), bfl: fakeStore() });
  await assert.rejects(() => store.save({ kind: 'bfl' }), { code: 'INVALID_CHANNEL' });
});

test('describe 一次回三块配置，面板切 tab 才能立刻回填', async () => {
  const store = createChannelStore({ dir: tempDir(), aliyun: fakeStore(), openai: fakeStore(), bfl: fakeStore() });
  const view = await store.describe();
  for (const key of ['aliyun', 'openai', 'bfl']) {
    assert.ok(view[key], '缺少 ' + key + ' 块');
    assert.equal(typeof view[key].hasKey, 'boolean');
  }
});

// wincred.ps1 的 -Target 参数有一道 ValidatePattern 白名单。新增一个凭据槽
// （BFL 就是这么加的）如果只改 Node 侧、忘了改这个正则，脚本会以参数校验失败退出，
// 表面症状是「无法保存 API 凭据」——既不说哪个 target，也不说为什么。
// 单测全是假 store，碰不到真脚本，所以只能直接盯文件。
test('凭据脚本的白名单覆盖代码里用到的每一个凭据槽', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wincred.ps1'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'channel-store.js'), 'utf8');
  const targets = new Set();
  for (const m of source.matchAll(/target:\s*'(Studio\.[A-Za-z0-9._]+)'/g)) targets.add(m[1]);
  for (const m of source.matchAll(/'Studio\.AiImg\.[A-Za-z0-9._]+'/g)) targets.add(m[0].replace(/'/g, ''));
  // Bailian 在 Node 侧是 createCredentialStore() 的默认值，不会以字面量出现，
  // 所以只要求认出「显式传参」的那几个；Bailian 单独确认白名单里有它。
  assert.ok(targets.size >= 2, '至少应该认出 ThirdParty / BFL 两个槽，实际：' + [...targets].join(','));
  assert.ok(targets.has('Studio.AiImg.BFL'), 'BFL 是这次新加的槽，必须被盯住');
  const pattern = /ValidatePattern\('(\^Studio[^']+\$)'\)/.exec(script);
  assert.ok(pattern, '没找到校验正则，脚本结构可能变了');
  const names = pattern[1].split('|').map((x) => x.replace(/[\^\$\\(\).]/g, '')).filter(Boolean);
  for (const target of targets) {
    const leaf = target.replace('Studio.AiImg.', '');
    assert.ok(
      pattern[1].includes(leaf),
      '凭据脚本不认识 ' + target + '：代码里在用它，但 ValidatePattern 白名单只有 ' + names.join(' / ')
    );
  }
});
