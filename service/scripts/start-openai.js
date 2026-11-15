'use strict';

// 用第三方（OpenAI 兼容）渠道启动本地服务。
//
// 为什么不用 .cmd/.bat：项目路径含中文（E:\桌面\...），批处理在 GBK 环境下
// 读中文路径容易乱码，之前也踩过。这里用 Node 读配置、设环境变量、再启动，
// 编码问题一次绕开。
//
// 用法：
//   1. 复制 openai.env.example 为 openai.env，填地址和 Key
//   2. npm run start:openai

const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, '..', 'openai.env');

if (!fs.existsSync(configPath)) {
  process.stderr.write([
    '还没配置第三方渠道。',
    '',
    '请把 service/openai.env.example 复制成 service/openai.env，填好：',
    '  STUDIO_BASE_URL=https://api.example.com/v1',
    '  STUDIO_API_KEY=sk-...',
    '  STUDIO_MODEL=gpt-image-1',
    '',
    '不确定填哪个模型时，先跑一次探针：',
    '  npm run probe -- --base-url https://api.example.com/v1 --api-key sk-...',
    ''
  ].join('\n'));
  process.exit(1);
}

for (const raw of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!match) continue;
  // 允许写成 "带引号的值"，有些面板复制出来会带引号。
  const value = match[2].trim().replace(/^["'](.*)["']$/, '$1');
  process.env[match[1]] = value;
}

process.env.STUDIO_PROVIDER = process.env.STUDIO_PROVIDER || 'openai';

if (!process.env.STUDIO_BASE_URL || !process.env.STUDIO_API_KEY) {
  process.stderr.write('openai.env 里缺少 STUDIO_BASE_URL 或 STUDIO_API_KEY。\n');
  process.exit(1);
}

require('../src/main').start();
