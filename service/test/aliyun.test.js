const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createAliyunProvider } = require('../src/providers/aliyun');

const endpoint = 'https://workspace.cn-beijing.maas.aliyuncs.com';
const image = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + Buffer.from('fixture').toString('base64') };

function withFetch(responseBody, status = 200) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  };
  return { requests, provider: createAliyunProvider({ fetchImpl, endpoint, apiKey: 'secret-test-key' }) };
}

test('whole edit submits the correct model, function and strength', async () => {
  const { requests, provider } = withFetch({ output: { task_id: 'task-1', task_status: 'PENDING' }, request_id: 'request-1' });
  assert.equal((await provider.submit({ operation: 'editWhole', prompt: '把天空改为黄昏', image, n: 1, strength: 0.7 })).taskId, 'task-1');
  assert.match(requests[0].url, /image2image\/image-synthesis$/);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-test-key');
  assert.equal(requests[0].init.headers['X-DashScope-Async'], 'enable');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'wanx2.1-imageedit');
  assert.equal(body.input.function, 'description_edit');
  assert.equal(body.parameters.strength, 0.7);
  assert.equal(body.parameters.n, 1);
});

test('masked edit sends a strictly black-and-white cloud mask', async () => {
  const gray = await sharp(Buffer.from([0, 80, 128, 255]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer();
  const mask = { kind: 'encoded', dataUrl: 'data:image/png;base64,' + gray.toString('base64') };
  const { requests, provider } = withFetch({ output: { task_id: 'task-2', task_status: 'PENDING' } });
  await provider.submit({ operation: 'editMasked', prompt: '补全背景', image, mask, n: 1 });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.input.function, 'description_edit_with_mask');
  const sent = Buffer.from(body.input.mask_image_url.split(',')[1], 'base64');
  assert.deepEqual([...await sharp(sent).greyscale().raw().toBuffer()], [0, 0, 255, 255]);
});

test('manual transparent-border expansion crops the core and infers right scale', async () => {
  const pixels = Buffer.alloc(800 * 600 * 4);
  for (let y = 0; y < 600; y++) for (let x = 0; x < 600; x++) pixels[(y * 800 + x) * 4 + 3] = 255;
  const png = await sharp(pixels, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer();
  const selected = Buffer.alloc(800 * 600);
  for (let y = 0; y < 600; y++) selected.fill(255, y * 800 + 600, y * 800 + 800);
  const maskPng = await sharp(selected, { raw: { width: 800, height: 600, channels: 1 } }).png().toBuffer();
  const { requests, provider } = withFetch({ output: { task_id: 'task-3', task_status: 'PENDING' } });
  await provider.submit({ operation: 'expand', prompt: '自然延伸', image: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + png.toString('base64') }, mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,' + maskPng.toString('base64') }, n: 1 });
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.input.function, 'expand');
  assert.equal(body.parameters.right_scale, 1 + 200 / 600);
  assert.equal((await sharp(Buffer.from(body.input.base_image_url.split(',')[1], 'base64')).metadata()).width, 600);
});

test('text-to-image uses the Wan 2.7 image-generation endpoint and messages format', async () => {
  const { requests, provider } = withFetch({ output: { task_id: 'task-4', task_status: 'PENDING' } });
  await provider.submit({ operation: 'generate', prompt: '一只白色花瓶', size: '1024*1024', n: 2, seed: 42 });
  assert.match(requests[0].url, /image-generation\/generation$/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'wan2.7-image');
  assert.deepEqual(body.input.messages, [{ role: 'user', content: [{ text: '一只白色花瓶' }] }]);
  assert.equal(body.parameters.size, '1024*1024');
  assert.equal(body.parameters.n, 2);
  assert.equal(body.parameters.seed, 42);
});

test('poll understands both result shapes and provider errors never reveal the API key', async () => {
  const edit = withFetch({ output: { task_id: 'task-5', task_status: 'SUCCEEDED', results: [{ url: 'https://example.oss-cn-beijing.aliyuncs.com/one.png' }] } });
  assert.deepEqual((await edit.provider.poll('task-5')).resultUrls, ['https://example.oss-cn-beijing.aliyuncs.com/one.png']);
  const generation = withFetch({ output: { task_id: 'task-6', task_status: 'SUCCEEDED', choices: [{ message: { content: [{ type: 'image', image: 'https://example.oss-cn-beijing.aliyuncs.com/two.png' }] } }] } });
  assert.deepEqual((await generation.provider.poll('task-6')).resultUrls, ['https://example.oss-cn-beijing.aliyuncs.com/two.png']);
  const failed = withFetch({ code: 'InvalidApiKey', message: 'secret-test-key is invalid' }, 401);
  await assert.rejects(failed.provider.submit({ operation: 'generate', prompt: '花瓶', size: '1024*1024', n: 1 }), (error) => error.code === 'ALIYUN_REQUEST_FAILED' && !error.message.includes('secret-test-key'));
});
