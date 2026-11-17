'use strict';

// 每次生成的成本估算。
//
// 数据来源与口径（2026-11-17 查证）：
//   - BFL：1 credit = US$0.01，官方 api.bfl.ai 定价
//     (docs.bfl.ai/quick_start/pricing)。flux-pro-1.1 = $0.04/张，
//     flux-pro-1.0-fill (Fill Pro) = $0.05/张，flux-2-pro = $0.03/MP。
//   - Gemini：gemini-2.5-flash-image = $0.039/张（1024 级，含 1290 token 输出）；
//     gemini-3-pro-image = $0.134/张（1K/2K）。Express Mode 同价。
//   - 汇率：1 USD = 6.71 CNY（2026-11-17 人行中间价）。
//
// 这是给面板看的「约数」，不是账单。BFL 有真实 credits 时优先用真实值；
// 其余渠道拿不到实际扣费，只能按公开价 × 张数估算，文案必须带「约」。
// 价格会变，改这里一处即可，不用动 provider。

const USD_CNY = 6.71;

// 每张美元的基准价。key 用小写，匹配时用模型名做前缀模糊。
const PER_IMAGE_USD = {
  // BFL（估算兜底；优先用下面的 credits 精确值）
  'flux-pro-1.1': 0.04,
  'flux-pro-1.0-fill': 0.05,
  'flux-pro-1.0-expand': 0.05,
  // flux-2-pro 官方 $0.03/MP，1MP 的基准价即 $0.03；实际按 MP 向上取整，
  // 由下面的 bflCredits() 精算（describe 对 bfl 走 credits 分支不走这里）。
  'flux-2-pro': 0.03,
  // Gemini
  'gemini-3-pro-image': 0.134,
  'gemini-3.1-flash-image': 0.039,
  'gemini-2.5-flash-image': 0.039
};

// BFL 官方按端点定价，1 credit = $0.01。有端点类型时给出精确的 credits：
//   pro-1.1 文生图 / fill / expand = 固定每张 4 / 5 / 5 credits
//   flux-2-pro = $0.03/MP（向上取整到像素）
// 这是官方单价直接换算，不是余额做差——没有延迟、并发串账的问题。
function bflCredits(endpoint, pixelCount) {
  const ep = String(endpoint || '').toLowerCase();
  if (ep.indexOf('fill') >= 0) return 5;
  if (ep.indexOf('expand') >= 0) return 5;
  if (ep.indexOf('flux-2-pro') >= 0) {
    const mp = Math.max(1, Math.ceil((Number(pixelCount) || 0) / 1e6));
    return Math.round(mp * 3 * 10) / 10; // $0.03/MP = 3 credits/MP
  }
  if (/flux-pro-1\.1|flux-1\.1|^flux-1|pro-1\.1/.test(ep)) return 4;
  return 4; // 默认按 1.1 Pro
}

// 按渠道给的默认价（模型名没匹配到时的兜底）。
const CHANNEL_DEFAULT_USD = {
  bfl: 0.04,
  openai: 0.039, // Vertex/Gemini
  aliyun: 0.038
};

function perImageUsd(channel, model) {
  const key = String(model || '').toLowerCase().trim();
  if (key) {
    // 最长前缀优先，避免 gemini-3-pro 被 gemini-3 之类的短名抢走。
    const names = Object.keys(PER_IMAGE_USD).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (key.indexOf(name) === 0) return PER_IMAGE_USD[name];
    }
  }
  return CHANNEL_DEFAULT_USD[channel] || 0;
}

function yuan(usd) {
  return (usd * USD_CNY).toFixed(2);
}

// cost 对象由 provider 上报：
//   { channel, model, imageCount, endpoint?, pixels? }
//   BFL 传 endpoint + pixels 就能按官方单价算出精确 credits；其余渠道按公开价估算。
//
// 返回一行可直接拼进结果提示文字的中文，例如：
//   "本次消耗 5 credits（约 ¥0.34）"         ← BFL 官方单价，精确
//   "本次约消耗 ¥0.26（Gemini 估算）"         ← 其余估算，明确带「约」
function describe(cost) {
  if (!cost || typeof cost !== 'object') return '';
  const channel = String(cost.channel || '');
  const imageCount = Math.max(1, Number(cost.imageCount) || 1);

  if (channel === 'bfl') {
    const credits = bflCredits(cost.endpoint, cost.pixels) * imageCount;
    const usd = credits * 0.01; // BFL: 1 credit = $0.01
    return '本次消耗 ' + String(credits) + ' credits（约 ¥' + yuan(usd) + '）';
  }

  const each = perImageUsd(channel, cost.model);
  if (!(each > 0)) return '';
  const usd = each * imageCount;
  // 中转站价格由对方自定，公开价只能是个数量级参考，文案要说清。
  const label = cost.label || (channel === 'openai' ? '公开价' : channel === 'aliyun' ? '百炼' : '公开价');
  return '本次约消耗 ¥' + yuan(usd) + '（' + label + '估算，实际以账单为准）';
}

module.exports = { describe, perImageUsd, bflCredits, USD_CNY };
