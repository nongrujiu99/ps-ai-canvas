'use strict';

const { createServer } = require('./server');
const { createCredentialStore } = require('./credential-store');
const { createJobManager } = require('./jobs');
const { createAliyunProvider } = require('./providers/aliyun');
const { createOpenAiCompatProvider } = require('./providers/openai-compat');
const { createVertexProvider, isVertexChannel } = require('./providers/vertex');
const { createBflProvider } = require('./providers/bfl');
const { createChannelStore, hostOf } = require('./channel-store');
const { createChannelProbe } = require('./channel-probe');
const { loadClientToken } = require('./client-token');

// 渠道解析放在「每次任务」而不是「进程启动」，这样面板里换渠道立刻生效，不用重启服务。
// 优先级：openai.env 的 STUDIO_PROVIDER（部署方锁定）> channel.json（面板里选的）> 百炼。
//
//   STUDIO_PROVIDER=openai
//   STUDIO_BASE_URL=https://api.example.com/v1
//   STUDIO_API_KEY=sk-xxx
//   STUDIO_MODEL=gpt-image-1
//   STUDIO_SIZES=1536x1024,1024x1024     （可选，覆盖尺寸档位）
//   STUDIO_MAX_PIXELS=4194304            （可选，覆盖送图上限）
function createRuntime({ credentialStore = createCredentialStore(), channelStore, providerFactory, channelProbe, allowedOrigins = ['null', 'file://', 'plugin://'], clientToken = loadClientToken() } = {}) {
  const channels = channelStore || createChannelStore({ aliyun: credentialStore });

  // 「服务端没配渠道」这件事以前用一句英文 missing settings 抛出去，面板显示
  // 「生成任务未完成」，用户完全不知道要去设置页填东西。
  function notConfigured(kind) {
    const messages = {
      openai: '还没配置第三方渠道：请在设置页填写服务地址、API Key 和模型名。',
      bfl: '还没配置 Black Forest Labs：请在设置页填写 API Key。'
    };
    const error = new Error(messages[kind] || '还没配置百炼：请在设置页填写业务空间 ID 和 API Key。');
    error.code = 'CHANNEL_NOT_CONFIGURED';
    return error;
  }

  // 同步出图的渠道会一直等接口返回，画布大的时候远超默认值。允许部署方按需调大。
  const requestTimeoutMs = Number(process.env.STUDIO_REQUEST_TIMEOUT_MS) > 0
    ? Number(process.env.STUDIO_REQUEST_TIMEOUT_MS)
    : undefined;
  const jobTimeoutMs = Number(process.env.STUDIO_JOB_TIMEOUT_MS) > 0
    ? Number(process.env.STUDIO_JOB_TIMEOUT_MS)
    : undefined;

  // server 的统一配置检查只认 {apiKey, workspaceId} 两字段。这里做成跟随当前渠道的适配层：
  // 百炼直接用业务空间，第三方用 base URL 的 host 顶替（本来就没有「业务空间」这个概念）。
  const settingsStore = {
    async read() {
      const channel = await channels.resolve();
      if (!channel.apiKey) return null;
      return {
        apiKey: channel.apiKey,
        // server 的配置检查只认 {apiKey, workspaceId} 这两个字段。三个渠道各自用什么
        // 顶替这个位置：百炼是真业务空间；OpenAI 兼容和 BFL 都没有这个概念，用地址的 host。
        workspaceId: channel.workspaceId || hostOf(channel.baseUrl || '')
      };
    },
    save: (settings) => credentialStore.save(settings),
    clear: () => credentialStore.clear()
  };

  const jobManager = createJobManager({
    timeoutMs: jobTimeoutMs,
    providerFactory: async () => {
      const channel = await channels.resolve();
      if (channel.kind === 'openai') {
        if (!channel.apiKey || !channel.baseUrl) throw notConfigured('openai');
        // Vertex 是另一套协议（:generateContent + x-goog-api-key），不能交给
        // OpenAI 兼容适配器——那样会拿 Bearer 去敲 /images/edits，必然 401。
        if (isVertexChannel(channel)) {
          return providerFactory
            ? providerFactory(channel)
            : createVertexProvider({ requestTimeoutMs, ...channel });
        }
        return providerFactory ? providerFactory(channel) : createOpenAiCompatProvider({ requestTimeoutMs, ...channel });
      }
      // BFL：第三套协议（x-key + 真异步轮询 + 一个操作一个端点）。
      // 必须在 aliyun 兜底之前拦下来，否则会被当成没配业务空间的百炼。
      if (channel.kind === 'bfl') {
        if (!channel.apiKey) throw notConfigured('bfl');
        return providerFactory ? providerFactory(channel) : createBflProvider({ requestTimeoutMs, ...channel });
      }
      if (!channel.apiKey || !channel.workspaceId) throw notConfigured('aliyun');
      const config = { endpoint: `https://${channel.workspaceId}.cn-beijing.maas.aliyuncs.com`, apiKey: channel.apiKey };
      return providerFactory ? providerFactory(config) : createAliyunProvider(config);
    },
  });
  // 面板的「测试连通」只敲 GET /models，不生成图：不花钱、几秒出结果。
  const probeChannel = channelProbe || createChannelProbe({ fetchImpl: fetch });
  return createServer({
    jobManager,
    credentialStore: settingsStore,
    channelStore: channels,
    channelTester: probeChannel,
    allowedOrigins,
    clientToken
  });
}

function start() {
  const port = Number(process.env.STUDIO_PORT || 32145);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid STUDIO_PORT');
  const clientToken = loadClientToken();
  const channels = createChannelStore();
  const server = createRuntime({ clientToken, channelStore: channels });
  server.listen(port, '127.0.0.1', async () => {
    process.stdout.write(`AI IMAGE STUDIO local service ready on 127.0.0.1:${port}\n`);
    const channel = await channels.resolve().catch(() => null);
    if (!channel) {
      process.stdout.write('Provider: 无法读取渠道配置\n');
    } else if (channel.kind === 'openai') {
      const label = isVertexChannel(channel) ? 'vertex-express' : 'openai-compat';
      process.stdout.write(`Provider: ${label}  ${channel.baseUrl || '(未配置地址)'}  model=${channel.model || '(未配置模型)'}${channel.source === 'env' ? '  [env 锁定]' : ''}\n`);
    } else if (channel.kind === 'bfl') {
      process.stdout.write(`Provider: bfl  ${channel.baseUrl || 'https://api.bfl.ai'}  model=${channel.model || '(默认 flux-pro-1.1)'}${channel.source === 'env' ? '  [env 锁定]' : ''}\n`);
    } else {
      process.stdout.write('Provider: aliyun (百炼业务空间)\n');
    }
    // Node 的 fetch 不读 HTTPS_PROXY（curl 读，Node 不读）。海外渠道必须走代理，
    // 用户却以为「系统代理开着就行」，于是连接失败时只会去改 Key 和模型名。
    // 启动时把这件事写在最前面，比事后从错误码反推便宜得多。
    const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const proxyOn = process.env.NODE_USE_ENV_PROXY === '1' || process.argv.includes('--use-env-proxy');
    if (proxyEnv && !proxyOn) {
      process.stdout.write(`Proxy: 检测到 ${proxyEnv}，但 Node 默认不走它 —— 海外渠道需要用 npm run start:proxy 启动，或开 TUN/全局模式\n`);
    }
    process.stdout.write(`Local connection code: ${clientToken}\n`);
  });
  server.on('error', (error) => {
    // 只写一句「could not start」用户根本不知道下一步做什么。端口占用是最常见的失败，
    // 单独给出可执行的提示，其余情况至少把错误码带出来。
    const code = error && error.code ? String(error.code) : 'UNKNOWN';
    const detail = code === 'EADDRINUSE' ? `端口 ${port} 已被占用（可能上一个本地服务还没退出）` : code;
    process.stderr.write(`AI IMAGE STUDIO local service could not start: ${detail}\n`);
    process.exitCode = 1;
  });
  return server;
}

if (require.main === module) start();

module.exports = { createRuntime, start };
