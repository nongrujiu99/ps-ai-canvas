'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, bflCredits, perImageUsd } = require('../src/cost');

test('BFL 按官方端点单价给出精确 credits，不再依赖余额做差', () => {
  assert.equal(bflCredits('/v1/flux-pro-1.1'), 4);
  assert.equal(bflCredits('/v1/flux-pro-1.0-fill'), 5);
  assert.equal(bflCredits('/v1/flux-pro-1.0-expand'), 5);
});

test('BFL flux-2-pro 按每兆像素 3 credits 向上取整', () => {
  assert.equal(bflCredits('/v1/flux-2-pro', 1000 * 1000), 3);         // 正好 1MP
  assert.equal(bflCredits('/v1/flux-2-pro-preview', 1024 * 1024), 6); // 1.05MP → 2MP
  assert.equal(bflCredits('/v1/flux-2-pro', 2048 * 2048), 15);        // 4.19MP → 5MP
});

test('flux-2-pro 单价与 credits 口径一致（$0.03/MP = 3 credits/MP）', () => {
  // 两张表必须同源：perImageUsd 的每张基准价 = bflCredits 1MP 的 credits × $0.01。
  assert.equal(perImageUsd('bfl', 'flux-2-pro'), 0.03);
  assert.equal(bflCredits('/v1/flux-2-pro', 1e6) * 0.01, 0.03);
});

test('BFL 真实值文案带 credits 和 ¥，不带「约消耗」字样', () => {
  const text = describe({ channel: 'bfl', endpoint: '/v1/flux-pro-1.0-fill', pixels: 2048 * 2560, imageCount: 1 });
  assert.match(text, /消耗 5 credits/);
  assert.match(text, /约 ¥/);
  assert.equal(text.indexOf('约消耗'), -1, '真实 credits 不该说成「约消耗」');
});

test('多张图时 credits 按张数累加', () => {
  const text = describe({ channel: 'bfl', endpoint: '/v1/flux-pro-1.1', pixels: 1024 * 1024, imageCount: 4 });
  assert.match(text, /消耗 16 credits/);
});

test('Gemini / 百炼 / 中转站都是估算，明确带「约」和「以账单为准」', () => {
  for (const cost of [
    { channel: 'openai', label: 'gemini', model: 'gemini-3.1-flash-image', imageCount: 1 },
    { channel: 'aliyun', model: 'wan2.7-image', imageCount: 1 },
    { channel: 'openai', label: '中转站', model: 'gpt-image-1', imageCount: 1 }
  ]) {
    const text = describe(cost);
    assert.match(text, /约消耗/);
    assert.match(text, /以账单为准/);
  }
});

test('显式 label 优先：中转站不会被误标成 Gemini', () => {
  const text = describe({ channel: 'openai', label: '中转站', model: 'gpt-image-1', imageCount: 1 });
  assert.match(text, /中转站估算/);
  assert.equal(text.indexOf('Gemini'), -1);
});

test('未知模型按渠道兜底价，仍有估算文案', () => {
  assert.ok(perImageUsd('openai', 'some-unknown-model') > 0);
  assert.match(describe({ channel: 'openai', label: 'Gemini', model: 'unknown', imageCount: 1 }), /约消耗 ¥/);
});

test('空 cost 不产生任何文案，不污染原有提示', () => {
  assert.equal(describe(null), '');
  assert.equal(describe({}), '');
});
