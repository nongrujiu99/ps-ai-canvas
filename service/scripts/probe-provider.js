'use strict';

// 第三方（OpenAI 兼容）渠道连通性探针。
//
// 用途：拿到一个中转站地址和 Key 之后，先用它换掉「猜」这一步——把模型列表、
// /images/edits 是否可用、接受哪些输出尺寸、返回 b64 还是 url，一次性测出来。
//
//   npm run probe -- --base-url https://xxx/v1 --api-key sk-xxx
//   npm run probe -- --base-url ... --api-key ... --models gpt-image-2,gemini-3.1-flash-image-preview
//   npm run probe -- --base-url ... --api-key ... --quick
//
// 模型名决定用哪套尺寸参数：
//   gemini / banana → tier 模式（image_size=1K/2K/4K + aspect_ratio）
//   其他            → pixels 模式（size=宽x高）
// 可用 --size-mode 强制覆盖。
//
// 注意：每次 edits 调用都会产生真实计费，默认每个模型测 3 个尺寸档，
// 用 --quick 每个模型只测第一个成功的。

const sharp = require('sharp');
const { normalizeBaseUrl } = require('../src/providers/openai-compat');

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index > 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  if (process.argv.includes('--' + name)) return true;
  return fallback;
}

const baseUrl = String(arg('base-url', process.env.STUDIO_BASE_URL || '')).trim();
const apiKey = String(arg('api-key', process.env.STUDIO_API_KEY || '')).trim();
const quick = process.argv.includes('--quick');
const forcedMode = String(arg('size-mode', '')).trim().toLowerCase();

const modelList = String(arg('models', arg('model', process.env.STUDIO_MODEL || 'gpt-image-2')))
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!baseUrl || !apiKey) {
  process.stderr.write('用法: npm run probe -- --base-url https://api.example.com/v1 --api-key sk-xxx [--models gpt-image-2,gemini-3.1-flash-image-preview] [--quick]\n');
  process.exit(2);
}

const root = normalizeBaseUrl(baseUrl);
const auth = { Authorization: `Bearer ${apiKey}` };

function line(label, value) {
  process.stdout.write(`${label.padEnd(26, ' ')}${value}\n`);
}

// 造一张「扩图现场」小样：左 2/3 是照片（带纹理），右 1/3 透明待补。
// 遮罩里透明区 = 要让模型重绘的部分，和插件实际发送的形态一致。
async function makeSample(width, height) {
  const photoRight = Math.round(width * 0.66);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const grain = ((x * 7 + y * 13) % 24) - 12;
      pixels[i] = Math.max(0, Math.min(255, 168 + grain));
      pixels[i + 1] = Math.max(0, Math.min(255, 146 + grain));
      pixels[i + 2] = Math.max(0, Math.min(255, 122 + grain));
      pixels[i + 3] = x < photoRight ? 255 : 0;
    }
  }
  const image = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const maskPixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = photoRight; x < width; x++) maskPixels[(y * width + x) * 4 + 3] = 0;
  }
  const mask = await sharp(maskPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { image, mask, width, height };
}

async function listModels() {
  let response;
  try {
    response = await fetch(`${root}/models`, { headers: auth, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    return { ok: false, status: 0, message: `网络失败：${error.message}` };
  }
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok) return { ok: false, status: response.status, message: (payload && payload.error && payload.error.message) || text.slice(0, 120) };
  const list = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return { ok: true, models: list.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean) };
}

function modeFor(model) {
  if (forcedMode === 'tier' || forcedMode === 'pixels') return forcedMode;
  return /gemini|banana|nano/i.test(model) ? 'tier' : 'pixels';
}

async function tryEdit(sample, model, size, mode) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', '补全透明区域，延续左侧的材质与光线。');
  form.append('n', '1');
  if (size !== 'auto') form.append(mode === 'tier' ? 'image_size' : 'size', size);
  form.append('image', new Blob([sample.image], { type: 'image/png' }), 'image.png');
  form.append('mask', new Blob([sample.mask], { type: 'image/png' }), 'mask.png');

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${root}/images/edits`, { method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(180000) });
  } catch (error) {
    return { size, ok: false, message: `网络失败：${error.message}` };
  }
  const elapsed = Date.now() - started;
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok) {
    const message = (payload && payload.error && (payload.error.message || payload.error.code)) || text.slice(0, 160) || `HTTP ${response.status}`;
    return { size, ok: false, elapsed, message: String(message).slice(0, 180) };
  }
  const items = (payload && (payload.data || payload.images)) || [];
  const first = items[0];
  let kind = '未知';
  let bytes = null;
  if (first && typeof first.b64_json === 'string') { kind = 'b64_json'; bytes = Buffer.from(first.b64_json, 'base64'); }
  else if (first && typeof first.url === 'string') {
    kind = 'url';
    try {
      const download = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
      if (download.ok) bytes = Buffer.from(await download.arrayBuffer());
    } catch { bytes = null; }
  } else if (first && typeof first.image === 'string') { kind = 'image_url'; }

  let dimensions = '无法解析';
  if (bytes) {
    try {
      const meta = await sharp(bytes).metadata();
      dimensions = `${meta.width}×${meta.height} ${meta.format}`;
      // 顺便验一下遮罩有没有被尊重：原照片区（左侧）应该基本保持原样
    } catch { dimensions = '无法解析'; }
  }
  return { size, ok: true, elapsed, kind, dimensions, count: items.length };
}

(async () => {
  process.stdout.write('\n=== 图像渠道探针 ===\n');
  line('接口根地址', root);
  line('待测模型', modelList.join(', '));

  process.stdout.write('\n[1/3] 鉴权与模型列表\n');
  const models = await listModels();
  if (!models.ok) {
    line('  结果', `失败${models.status ? ` (${models.status})` : ''} ${models.message}`);
    process.stdout.write('  提示：地址或 Key 不对；也可能该站不提供 /models，可忽略继续测 edits。\n');
  } else {
    line('  结果', `可用，共 ${models.models.length} 个`);
    const imageLike = models.models.filter((id) => /image|dall|flux|seedream|banana|imagen|qwen|wan|grok/i.test(id));
    if (imageLike.length) line('  图像相关', imageLike.slice(0, 16).join(', '));
    for (const model of modelList) {
      if (!models.models.includes(model)) line('  注意', `模型列表里没有 ${model}，仍会直接调用尝试`);
    }
  }

  process.stdout.write('\n[2/3] /images/edits 尺寸探测\n');
  const sample = await makeSample(704, 512);
  const summary = [];
  for (const model of modelList) {
    const mode = modeFor(model);
    const candidates = mode === 'tier' ? ['4K', '2K', 'auto'] : [`${sample.width}x${sample.height}`, 'auto', '1024x1024'];
    line(`  ${model}`, `(${mode} 模式)`);
    const results = [];
    for (const size of candidates) {
      const result = await tryEdit(sample, model, size, mode);
      results.push(result);
      if (result.ok) line(`    ${size}`, `OK  ${result.elapsed}ms  返回=${result.kind}  尺寸=${result.dimensions}  张数=${result.count}`);
      else line(`    ${size}`, `失败  ${result.message}`);
      if (quick && result.ok) break;
    }
    summary.push({ model, mode, results });
    process.stdout.write('\n');
  }

  process.stdout.write('[3/3] 结论\n');
  const usable = summary.filter((s) => s.results.some((r) => r.ok));
  if (usable.length === 0) {
    line('  可用', '无 —— 该站可能不支持 images/edits');
    process.stdout.write('  没有 edits 就只能整图重绘，和现在的百炼扩图相比没有优势。\n');
  } else {
    for (const item of usable) {
      const working = item.results.filter((r) => r.ok);
      const exact = item.mode === 'pixels' && working.some((r) => r.size === `${sample.width}x${sample.height}`);
      const tiered = item.mode === 'tier' && working.some((r) => r.size === '4K');
      line(`  ${item.model}`,
        `可用尺寸 ${working.map((r) => r.size).join('/')} | ${exact ? '支持精确尺寸' : tiered ? '支持 4K 档' : '仅固定档位'}`);
    }
    const best = usable.find((s) => s.mode === 'tier' && s.results.some((r) => r.ok && r.size === '4K'))
      || usable.find((s) => s.results.some((r) => r.ok && r.size === `${sample.width}x${sample.height}`));
    if (best) {
      process.stdout.write(`\n  推荐先用 ${best.model}：`);
      process.stdout.write(best.mode === 'tier' ? '4K 档，画布几乎不用缩。\n' : '支持精确尺寸，扩图不丢分辨率。\n');
    }
  }

  const pick = (usable[0] && usable[0].model) || modelList[0];
  const pickMode = modeFor(pick);
  process.stdout.write('\n把这些填进 service/openai.env，然后 npm run start:openai：\n');
  process.stdout.write(`  STUDIO_BASE_URL=${root}\n`);
  process.stdout.write('  STUDIO_API_KEY=<你的 key>\n');
  process.stdout.write(`  STUDIO_MODEL=${pick}\n`);
  if (pickMode === 'tier') process.stdout.write('  STUDIO_SIZE_MODE=tier\n');
  process.stdout.write('\n');
})().catch((error) => {
  process.stderr.write(`探针异常: ${error && error.message}\n`);
  process.exitCode = 1;
});
