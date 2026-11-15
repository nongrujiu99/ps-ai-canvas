'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('./credential-store');
const { problem } = require('./contract');
const { DEFAULT_ALLOWED_SIZES } = require('./providers/openai-compat');
const { isVertexChannel, isVertexBaseUrl } = require('./providers/vertex');

// 渠道配置：让用户自己在面板里切换「百炼 / 第三方 API」，不用改 env 文件、不用重开终端。
//
// 分成两半存，各自放在合适的地方：
//   - 非敏感字段（渠道种类、地址、模型、尺寸模式）→ %APPDATA%\Studio AI Image\channel.json
//   - API Key → Windows 凭据管理器（百炼用 Studio.AiImg.Bailian，第三方用 Studio.AiImg.ThirdParty）
// Key 不落 json：这个文件用户随时会用记事本打开看，明文存 Key 等于把密钥摊在桌面上。
//
// env 仍然有最高优先级：openai.env 里显式写了 STUDIO_PROVIDER，说明这是部署方锁定的渠道，
// 面板改不动（只读回显），避免「面板里换了渠道，重启后又被 env 覆盖回去」的困惑。

const OPENAI_ALIASES = new Set(['openai', 'openai-compat', 'compat', 'thirdparty', 'third-party']);

function dataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Studio AI Image');
}

// 同一个 base URL 在不同语境下都可能当作「业务空间标识」，尽量给出可读的名字。
function hostOf(url) {
  try { return new URL(url).host; } catch { return 'openai-compat'; }
}

function isOpenAiAlias(value) {
  return OPENAI_ALIASES.has(String(value || '').trim().toLowerCase());
}

// 渠道显示名称：面板顶部那一行左边显示的就是它。
// 只做两件事——去掉控制字符（换行会在单行胶囊里撑破布局）和截断，
// 不做「必须像名字」之类的校验：用户填「我的中转站」和填「ai.comfly」都合理。
const NAME_LIMIT = 24;
function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_LIMIT);
}

// env 里的渠道配置。返回 null 表示「没配第三方」。
function fromEnv(env = process.env) {
  if (!isOpenAiAlias(env.STUDIO_PROVIDER)) return null;
  return {
    baseUrl: String(env.STUDIO_BASE_URL || '').trim(),
    apiKey: String(env.STUDIO_API_KEY || '').trim(),
    model: String(env.STUDIO_MODEL || '').trim() || 'gpt-image-1',
    name: cleanName(env.STUDIO_CHANNEL_NAME),
    allowedSizes: String(env.STUDIO_SIZES || '').split(',').map((item) => item.trim()).filter(Boolean),
    maxPixels: Number(env.STUDIO_MAX_PIXELS) > 0 ? Number(env.STUDIO_MAX_PIXELS) : undefined,
    sizeMode: String(env.STUDIO_SIZE_MODE || '').trim().toLowerCase() === 'tier' ? 'tier' : 'pixels',
    aspectRatio: String(env.STUDIO_ASPECT_RATIO || '').trim() || undefined,
    sizeParam: String(env.STUDIO_SIZE_PARAM || '').trim() || 'size',
    tierParam: String(env.STUDIO_TIER_PARAM || '').trim() || 'image_size'
  };
}

// 「想用第三方」和「不许面板改」是两件事，必须分开。
// start-openai.js 会自动补 STUDIO_PROVIDER，如果它同时意味着「锁定」，
// 那面板里的渠道设置永远改不动——这个坑很隐蔽。
function isLockFlag(env = process.env) {
  const value = String(env.STUDIO_LOCK_PROVIDER || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function createChannelStore({ dir = dataDir(), aliyun = createCredentialStore(), openai = createCredentialStore({ target: 'Studio.AiImg.ThirdParty' }), bfl = createCredentialStore({ target: 'Studio.AiImg.BFL' }), env = process.env } = {}) {
  const file = path.join(dir, 'channel.json');
  const envConfig = fromEnv(env);
  const locked = envConfig && isLockFlag(env) ? envConfig : null;

  function readSaved() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      // 文件不存在是最常见的情况（首次使用），不吵；解析失败要说一声，
      // 否则用户改了 json 却不生效，会以为面板坏了。
      if (!error || error.code !== 'ENOENT') {
        process.stderr.write('[channel] 配置文件无法读取，按默认渠道处理：' + (error && error.code) + '\n');
      }
      return {};
    }
  }

  function writeSaved(data) {
    fs.mkdirSync(dir, { recursive: true });
    // 先写临时文件再改名：写到一半断电不会留下半截 json 把面板锁死。
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  // 凭据读失败（没配过、凭据库异常）不该让整个设置页崩掉，一律当「没有 Key」。
  async function readKey(store) {
    try {
      const value = await store.read();
      return value && typeof value.apiKey === 'string' && value.apiKey ? value : null;
    } catch {
      return null;
    }
  }

  // 服务端真正拿去建 provider 的配置（含明文 Key，只在进程内流转，不返回给面板）。
  async function resolve() {
    if (locked) {
      return { kind: 'openai', source: 'env', ...locked, allowedSizes: locked.allowedSizes.length ? locked.allowedSizes : DEFAULT_ALLOWED_SIZES };
    }
    const saved = readSaved();
    // 面板里还没存过渠道时，env 的配置当默认值用——但不锁定，用户随时能改。
    if (!saved.kind && envConfig) {
      return { kind: 'openai', source: 'env-default', ...envConfig, allowedSizes: envConfig.allowedSizes.length ? envConfig.allowedSizes : DEFAULT_ALLOWED_SIZES };
    }
    const openaiSaved = saved.openai && typeof saved.openai === 'object' ? saved.openai : {};
    // BFL 走自己的凭据槽和配置块。这条必须在「aliyun 兜底」之前返回，
    // 否则选了 BFL 会被当成没配业务空间的百炼，报一句看不懂的错。
    if (saved.kind === 'bfl') {
      const bflSaved = saved.bfl && typeof saved.bfl === 'object' ? saved.bfl : {};
      const credential = await readKey(bfl);
      return {
        kind: 'bfl',
        source: 'panel',
        baseUrl: String(bflSaved.baseUrl || '') || 'https://api.bfl.ai',
        model: String(bflSaved.model || ''),
        name: cleanName(bflSaved.name),
        apiKey: credential ? credential.apiKey : ''
      };
    }
    if (saved.kind === 'openai') {
      const credential = await readKey(openai);
      return {
        kind: 'openai',
        source: 'panel',
        baseUrl: String(openaiSaved.baseUrl || ''),
        model: String(openaiSaved.model || ''),
        name: cleanName(openaiSaved.name),
        sizeMode: openaiSaved.sizeMode === 'tier' ? 'tier' : 'pixels',
        maxPixels: Number(openaiSaved.maxPixels) > 0 ? Number(openaiSaved.maxPixels) : undefined,
        aspectRatio: String(openaiSaved.aspectRatio || '').trim() || undefined,
        allowedSizes: DEFAULT_ALLOWED_SIZES,
        sizeParam: 'size',
        tierParam: 'image_size',
        apiKey: credential ? credential.apiKey : ''
      };
    }
    const credential = await readKey(aliyun);
    return {
      kind: 'aliyun',
      source: 'panel',
      apiKey: credential ? credential.apiKey : '',
      workspaceId: credential ? credential.workspaceId : ''
    };
  }

  // 给面板看的安全视图：只有「有没有 Key」，没有 Key 本身。
  // 三个渠道块**一起返回**，面板切 tab 时才能立刻回填另一家已经存好的配置，
  // 不用再点一次「保存」才看得到。
  async function describe() {
    const saved = readSaved();
    const openaiSaved = saved.openai && typeof saved.openai === 'object' ? saved.openai : {};
    const bflSaved = saved.bfl && typeof saved.bfl === 'object' ? saved.bfl : {};
    const [aliyunCredential, openaiCredential, bflCredential] = await Promise.all([readKey(aliyun), readKey(openai), readKey(bfl)]);
    // 回显优先级：锁定值 > 面板保存值 > env 默认值。
    const fallback = !saved.kind && envConfig ? envConfig : null;
    const effective = locked || fallback;
    const kind = locked ? 'openai'
      : saved.kind === 'openai' ? 'openai'
        : saved.kind === 'bfl' ? 'bfl'
          : saved.kind === 'aliyun' ? 'aliyun'
            : (fallback ? 'openai' : 'aliyun');
    return {
      kind,
      locked: Boolean(locked),
      lockedNote: locked ? '渠道已由 openai.env 的 STUDIO_LOCK_PROVIDER 固定，改这里不会生效。' : '',
      aliyun: {
        workspaceId: aliyunCredential ? aliyunCredential.workspaceId : '',
        hasKey: Boolean(aliyunCredential)
      },
      bfl: {
        baseUrl: String(bflSaved.baseUrl || '') || 'https://api.bfl.ai',
        model: String(bflSaved.model || ''),
        name: cleanName(bflSaved.name),
        hasKey: Boolean(bflCredential)
      },
      openai: {
        baseUrl: effective ? effective.baseUrl : String(openaiSaved.baseUrl || ''),
        // 面板按协议换模型预设：Vertex 的模型名（gemini-3.1-flash-image 等）
        // 和中转站的清单不是一回事，混在一起列会让人选到一个必然 404 的名字。
        protocol: isVertexBaseUrl(effective ? effective.baseUrl : openaiSaved.baseUrl) ? 'vertex' : 'openai',
        model: effective ? effective.model : String(openaiSaved.model || ''),
        // 显示名称只影响顶部那一行怎么称呼这个渠道，不参与任何请求。
        name: cleanName(effective ? effective.name : openaiSaved.name),
        sizeMode: effective ? effective.sizeMode : (openaiSaved.sizeMode === 'tier' ? 'tier' : 'pixels'),
        maxPixels: effective ? (effective.maxPixels || 0) : (Number(openaiSaved.maxPixels) || 0),
        hasKey: Boolean(effective ? effective.apiKey : openaiCredential)
      }
    };
  }

  // 测试连通用的「草稿」：拿面板里还没保存的值（可能连 Key 都是刚敲进去的）拼一份
  // 跟 resolve() 同形的配置。不写文件、不碰凭据库，测完就丢。
  // Key 留空时沿用已保存的那把——这样用户只改模型也能直接测，不用重填 Key。
  async function resolveDraft(input) {
    const payload = input && typeof input === 'object' ? input : {};
    const isBfl = payload.kind === 'bfl';
    if (payload.kind && payload.kind !== 'openai' && !isBfl) {
      throw problem('INVALID_CHANNEL', '只有第三方 API 和 BFL 渠道支持连通测试。');
    }
    // BFL 的地址可以不填（就一个官方域名），模型也可以不填（适配器有默认值）：
    // 这两个字段在 BFL 上不存在「选错就静默失效」的风险，没必要拿它们拦住测试。
    const baseUrl = String(payload.baseUrl || '').trim() || (isBfl ? 'https://api.bfl.ai' : '');
    if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw problem('INVALID_CHANNEL', '服务地址需要以 http:// 或 https:// 开头。');
    const model = String(payload.model || '').trim();
    const typed = String(payload.apiKey || '').trim();
    const credential = typed ? null : await readKey(isBfl ? bfl : openai);
    const apiKey = typed || (credential ? credential.apiKey : '');
    if (!apiKey) throw problem('INVALID_CHANNEL', '请先填写 API Key。');
    // Vertex Express Mode 的探针用的是内置的固定模型，跟用户选的生图模型无关，
    // 所以这种情况下不该拿「还没选模型」拦住连通测试——地址和 Key 先验了再说。
    if (!model && !isBfl && !isVertexChannel({ baseUrl, apiKey })) throw problem('INVALID_CHANNEL', '请先选择模型。');
    return { kind: isBfl ? 'bfl' : 'openai', baseUrl, model, apiKey, sizeMode: payload.sizeMode === 'tier' ? 'tier' : 'pixels' };
  }

  async function save(input) {
    if (locked) throw problem('CHANNEL_LOCKED', '渠道由 openai.env 的 STUDIO_PROVIDER 固定，请改配置文件后重启服务。');
    const payload = input && typeof input === 'object' ? input : {};
    const kind = payload.kind === 'bfl' ? 'bfl' : (payload.kind === 'openai' ? 'openai' : 'aliyun');
    const saved = readSaved();
    const openaiSaved = saved.openai && typeof saved.openai === 'object' ? saved.openai : {};
    const next = Object.assign({}, saved, { kind });

    if (kind === 'openai') {
      const baseUrl = String(payload.baseUrl || '').trim();
      if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw problem('INVALID_CHANNEL', '服务地址需要以 http:// 或 https:// 开头。');
      const model = String(payload.model || '').trim();
      if (!model) throw problem('INVALID_CHANNEL', '请填写模型名称。');
      const apiKey = String(payload.apiKey || '').trim();
      // 允许只改地址/模型而不重填 Key：Key 已经在凭据库里就沿用。
      if (!apiKey && !(await readKey(openai))) throw problem('INVALID_CHANNEL', '请填写 API Key。');
      if (apiKey) await openai.save({ apiKey, workspaceId: hostOf(baseUrl) });
      next.openai = {
        baseUrl,
        model,
        // 留空就回落成默认的「第三方 API」，所以空字符串照存，不写 undefined。
        name: cleanName(payload.name),
        sizeMode: payload.sizeMode === 'tier' ? 'tier' : 'pixels',
        // 面板没有「送图像素上限」这个字段。以前这里一律取 payload，等于用户改一下模型
        // 就被悄悄重置成默认 4.19M，大图被降采样还不报错。没传就沿用已保存的值。
        maxPixels: Number(payload.maxPixels) > 0
          ? Math.round(Number(payload.maxPixels))
          : (Number(openaiSaved.maxPixels) > 0 ? Number(openaiSaved.maxPixels) : 0),
        aspectRatio: String(payload.aspectRatio || '').trim()
      };
    } else if (kind === 'bfl') {
      // 地址可以留空：官方只有这一个域名，绝大多数人就是用它。
      const baseUrl = String(payload.baseUrl || '').trim() || 'https://api.bfl.ai';
      if (!/^https?:\/\/\S+$/i.test(baseUrl)) throw problem('INVALID_CHANNEL', '服务地址需要以 http:// 或 https:// 开头。');
      // 模型留空是允许的：适配器回落到内置默认（flux-pro-1.1）。
      // 第三方那条不能这样放过——地址留着、模型空着，请求会打到根本不存在的模型上。
      const model = String(payload.model || '').trim();
      const apiKey = String(payload.apiKey || '').trim();
      if (!apiKey && !(await readKey(bfl))) throw problem('INVALID_CHANNEL', '请填写 API Key。');
      if (apiKey) await bfl.save({ apiKey, workspaceId: hostOf(baseUrl) });
      next.bfl = { baseUrl, model, name: cleanName(payload.name) };
    } else {
      const existing = await readKey(aliyun);
      const workspaceId = String(payload.workspaceId || '').trim() || (existing ? existing.workspaceId : '');
      const apiKey = String(payload.apiKey || '').trim() || (existing ? existing.apiKey : '');
      if (!workspaceId) throw problem('INVALID_CHANNEL', '请填写业务空间 ID。');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw problem('INVALID_CHANNEL', '业务空间 ID 只能用字母、数字、下划线和短横线。');
      if (!apiKey) throw problem('INVALID_CHANNEL', '请填写 API Key。');
      await aliyun.save({ apiKey, workspaceId });
      next.aliyun = { workspaceId };
    }

    writeSaved(next);
    return describe();
  }

  return { resolve, resolveDraft, describe, save, file, locked: Boolean(locked) };
}

module.exports = { createChannelStore, fromEnv, isOpenAiAlias, hostOf, dataDir, cleanName, OPENAI_ALIASES };
