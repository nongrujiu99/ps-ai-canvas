'use strict';

const sharp = require('sharp');
const { decodeCapture, prepareExpansion } = require('../image-inspection');
const { problem } = require('../contract');

function providerError(code, message) {
  return problem(code, message);
}

function createAliyunProvider({ fetchImpl = fetch, endpoint, apiKey, requestTimeoutMs = 30000 }) {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.cn-beijing.maas.aliyuncs.com')) {
    throw providerError('INVALID_ENDPOINT', '百炼业务空间地址无效。');
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    throw providerError('MISSING_API_KEY', '请先配置百炼 API Key。');
  }
  const root = base.origin;

  async function requestJson(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
      });
    } catch {
      throw providerError('ALIYUN_NETWORK', '无法连接百炼服务。');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw providerError('ALIYUN_RESPONSE', '百炼返回了无法识别的响应。');
    }
    if (!response.ok || payload.code) {
      throw providerError('ALIYUN_REQUEST_FAILED', `百炼请求失败${payload.code ? `（${String(payload.code).replace(/[^A-Za-z0-9_]/g, '')}）` : ''}。`);
    }
    return payload;
  }

  async function imageDataUrl(image) {
    if (image.kind === 'encoded') return image.dataUrl;
    const { pngBytes } = await decodeCapture(image);
    return `data:image/png;base64,${pngBytes.toString('base64')}`;
  }

  async function submit(job) {
    let path, body;
    if (job.operation === 'generate') {
      path = '/api/v1/services/aigc/image-generation/generation';
      body = {
        model: 'wan2.7-image',
        input: { messages: [{ role: 'user', content: [{ text: job.prompt }] }] },
        parameters: { size: job.size, n: job.n, watermark: false, ...(job.seed === undefined ? {} : { seed: job.seed }) },
      };
    } else {
      path = '/api/v1/services/aigc/image2image/image-synthesis';
      let imageUrl = await imageDataUrl(job.image);
      const input = { prompt: job.prompt, base_image_url: imageUrl };
      const parameters = { n: job.n, ...(job.seed === undefined ? {} : { seed: job.seed }) };
      if (job.operation === 'editMasked') {
        input.function = 'description_edit_with_mask';
        const { maskBytes } = await decodeCapture(job.image, job.mask);
        const binary = await sharp(maskBytes).removeAlpha().greyscale().threshold(128).png().toBuffer();
        input.mask_image_url = `data:image/png;base64,${binary.toString('base64')}`;
      } else if (job.operation === 'editWhole') {
        input.function = 'description_edit';
        parameters.strength = job.strength;
      } else if (job.operation === 'expand') {
        input.function = 'expand';
        let scales = job.scales;
        if (job.mask) {
          const { pngBytes, maskBytes } = await decodeCapture(job.image, job.mask);
          const prepared = await prepareExpansion(pngBytes, maskBytes);
          imageUrl = `data:image/png;base64,${prepared.originalPng.toString('base64')}`;
          input.base_image_url = imageUrl;
          scales = { top: prepared.topScale, right: prepared.rightScale, bottom: prepared.bottomScale, left: prepared.leftScale };
        }
        parameters.top_scale = scales.top;
        parameters.right_scale = scales.right;
        parameters.bottom_scale = scales.bottom;
        parameters.left_scale = scales.left;
      } else {
        throw providerError('INVALID_OPERATION', '不支持的图像操作。');
      }
      body = { model: 'wanx2.1-imageedit', input, parameters };
    }
    const payload = await requestJson(root + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify(body),
    });
    const taskId = payload.output && payload.output.task_id;
    if (typeof taskId !== 'string' || !taskId) throw providerError('ALIYUN_RESPONSE', '百炼未返回任务编号。');
    return { taskId };
  }

  async function poll(taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw providerError('INVALID_TASK_ID', '任务编号无效。');
    const payload = await requestJson(root + '/api/v1/tasks/' + encodeURIComponent(taskId));
    const output = payload.output || {};
    const resultUrls = [];
    for (const item of output.results || []) {
      if (typeof item.url === 'string') resultUrls.push(item.url);
    }
    for (const choice of output.choices || []) {
      for (const item of (choice.message && choice.message.content) || []) {
        if (item.type === 'image' && typeof item.image === 'string') resultUrls.push(item.image);
      }
    }
    return { status: output.task_status || 'UNKNOWN', resultUrls, errorCode: output.code || null };
  }

  async function download(url) {
    let target;
    try { target = new URL(url); } catch { throw providerError('RESULT_URL', '结果地址无效。'); }
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.aliyuncs.com')) {
      throw providerError('RESULT_URL', '结果地址无效。');
    }
    let response;
    try { response = await fetchImpl(target.href, { signal: AbortSignal.timeout(requestTimeoutMs) }); } catch { throw providerError('RESULT_DOWNLOAD', '结果下载失败。'); }
    if (!response.ok) throw providerError('RESULT_DOWNLOAD', '结果下载失败。');
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); }
    catch { throw providerError('RESULT_DOWNLOAD', '结果下载失败。'); }
    if (bytes.length === 0 || bytes.length > 30 * 1024 * 1024) throw providerError('RESULT_DOWNLOAD', '结果文件无效。');
    try { return await sharp(bytes).png().toBuffer(); }
    catch { throw providerError('RESULT_DOWNLOAD', '结果图像无法读取。'); }
  }

  return { submit, poll, download };
}

module.exports = { createAliyunProvider };
