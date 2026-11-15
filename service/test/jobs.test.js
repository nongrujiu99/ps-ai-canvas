const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobManager } = require('../src/jobs');

async function settled(manager, jobId) {
  for (let i = 0; i < 50; i++) {
    const job = manager.get(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('job did not settle');
}

test('a successful async task downloads remote results before reporting success', async () => {
  const statuses = ['PENDING', 'RUNNING', 'SUCCEEDED'];
  const provider = {
    submit: async () => ({ taskId: 'remote-1' }),
    poll: async () => ({ status: statuses.shift(), resultUrls: statuses.length ? [] : ['https://result.oss-cn-beijing.aliyuncs.com/a.png'] }),
    download: async () => Buffer.from('local-image-bytes'),
  };
  const manager = createJobManager({ provider, sleep: async () => {}, timeoutMs: 1000 });
  const { jobId } = await manager.start({ operation: 'generate' });
  const job = await settled(manager, jobId);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.resultCount, 1);
  assert.equal(manager.getResult(jobId, 0).toString(), 'local-image-bytes');
  assert.equal(JSON.stringify(job).includes('https://'), false);
});

test('failed task and rejected download never produce a successful-looking result', async () => {
  const failed = createJobManager({ provider: { submit: async () => ({ taskId: 'remote-2' }), poll: async () => ({ status: 'FAILED', errorCode: 'InvalidParameter', resultUrls: [] }) }, sleep: async () => {} });
  const a = await failed.start({ operation: 'editMasked' });
  assert.equal((await settled(failed, a.jobId)).status, 'failed');
  assert.throws(() => failed.getResult(a.jobId, 0), { code: 'RESULT_UNAVAILABLE' });

  const expired = createJobManager({ provider: { submit: async () => ({ taskId: 'remote-3' }), poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['https://result.oss-cn-beijing.aliyuncs.com/expired.png'] }), download: async () => { throw new Error('expired'); } }, sleep: async () => {} });
  const b = await expired.start({ operation: 'editWhole' });
  assert.equal((await settled(expired, b.jobId)).status, 'failed');
  assert.throws(() => expired.getResult(b.jobId, 0), { code: 'RESULT_UNAVAILABLE' });
});

test('waiting times out without submitting a second billable request', async () => {
  let submits = 0, clock = 0;
  const manager = createJobManager({ provider: { submit: async () => { submits++; return { taskId: 'remote-4' }; }, poll: async () => ({ status: 'PENDING', resultUrls: [] }) }, now: () => clock, sleep: async () => { clock += 4; }, timeoutMs: 6 });
  const { jobId } = await manager.start({ operation: 'expand' });
  assert.equal((await settled(manager, jobId)).errorCode, 'TASK_TIMEOUT');
  assert.equal(submits, 1);
});

test('cancel-wait stops local polling but does not pretend to cancel the cloud task', async () => {
  let release;
  const sleep = () => new Promise((resolve) => { release = resolve; });
  let polls = 0;
  const manager = createJobManager({ provider: { submit: async () => ({ taskId: 'remote-5' }), poll: async () => { polls++; return { status: 'PENDING', resultUrls: [] }; } }, sleep });
  const { jobId } = await manager.start({ operation: 'expand' });
  for (let i = 0; !release && i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  manager.cancelWait(jobId);
  release();
  assert.equal((await settled(manager, jobId)).status, 'cancelled');
  assert.equal(polls, 1);
});

test('a failed job carries the reason through to the panel instead of a bare code', async () => {
  // 面板以前只拿到 errorCode，再自己换成「生成任务未完成」，于是超时、模型名错、
  // 尺寸被拒在界面上完全一样，排查只能靠猜。原因必须跟着任务状态一起回传。
  const timeout = new Error('生成超时：接口 300 秒内没有返回结果。');
  timeout.code = 'PROVIDER_TIMEOUT';
  const manager = createJobManager({ provider: { submit: async () => { throw timeout; }, poll: async () => ({ status: 'PENDING', resultUrls: [] }) }, log: () => {} });
  const { jobId } = await manager.start({ operation: 'generate' });
  const job = await settled(manager, jobId);
  assert.equal(job.errorCode, 'PROVIDER_TIMEOUT');
  assert.match(job.errorMessage, /超时/);
});

test('a provider failure text containing a key is redacted from public job state', async () => {
  const manager = createJobManager({ provider: { submit: async () => { throw new Error('sk-very-secret-key failed'); }, poll: async () => ({ status: 'PENDING', resultUrls: [] }) } });
  const { jobId } = await manager.start({ operation: 'generate' });
  const job = await settled(manager, jobId);
  assert.equal(job.status, 'failed');
  assert.equal(JSON.stringify(job).includes('sk-very-secret-key'), false);
});

test('provider factory creates a separate provider for each submitted job', async () => {
  let next = 0;
  const used = [];
  const manager = createJobManager({ providerFactory: async () => {
    const id = ++next;
    return {
      submit: async () => { used.push(id); return { taskId: `task-${id}` }; },
      poll: async () => ({ status: 'SUCCEEDED', resultUrls: [`https://result.oss-cn-beijing.aliyuncs.com/${id}.png`] }),
      download: async () => Buffer.from(`result-${id}`),
    };
  } });
  const first = await manager.start({ operation: 'generate' });
  const second = await manager.start({ operation: 'generate' });
  await Promise.all([settled(manager, first.jobId), settled(manager, second.jobId)]);
  assert.deepEqual(used, [1, 2]);
  assert.equal(manager.getResult(first.jobId, 0).toString(), 'result-1');
  assert.equal(manager.getResult(second.jobId, 0).toString(), 'result-2');
});

test('a finished job is dropped after its TTL so resident memory does not grow forever', async () => {
  // 本地服务是常驻进程，每个任务都握着画布尺寸的 PNG。以前只 set 不 delete，
  // 一次会话做二十次生成，内存就只涨不降——这就是「用了一下午变卡」的来源。
  const provider = { submit: async () => ({ taskId: 'ttl' }), poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['u'] }), download: async () => Buffer.alloc(4096) };
  const manager = createJobManager({ provider, sleep: async () => {}, resultTtlMs: 5 });
  const { jobId } = await manager.start({ operation: 'generate' });
  await settled(manager, jobId);
  assert.equal(manager.stats().jobs, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.stats().jobs, 0);
  assert.throws(() => manager.get(jobId), { code: 'JOB_NOT_FOUND' });
});

test('the job table stays bounded even when nobody collects the results', async () => {
  const provider = { submit: async () => ({ taskId: 'bounded' }), poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['u'] }), download: async () => Buffer.alloc(1024) };
  const manager = createJobManager({ provider, sleep: async () => {}, maxJobs: 3 });
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await manager.start({ operation: 'generate' })).jobId);
  for (const id of ids) await settled(manager, id).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(manager.stats().jobs <= 3, '任务表必须有上限，实际 ' + manager.stats().jobs);
});

// ── 下载失败不能连图一起扔掉 ───────────────────────────────────────────
// 图已经生成好放在图床上了，只是没拉回来。以前失败时把 resultUrls 清空，面板只能
// 完整重跑——重新上传、重新等模型、重新计费。这个用例守住「重试 = 只重下」。
test('下载失败时保住结果链接，重试只重下不重新生成', async () => {
  let submits = 0;
  let downloads = 0;
  const provider = {
    submit: async () => { submits += 1; return { taskId: 'remote-r' }; },
    poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['https://cdn.example.com/a.png'] }),
    download: async () => {
      downloads += 1;
      if (downloads === 1) {
        const error = new Error('无法下载结果图像（ECONNRESET）');
        error.code = 'RESULT_DOWNLOAD';
        throw error;
      }
      return Buffer.from('recovered-bytes');
    },
  };
  const manager = createJobManager({ provider, sleep: async () => {} });
  const { jobId } = await manager.start({ operation: 'expand' });
  const failed = await settled(manager, jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'RESULT_DOWNLOAD');

  const recovered = await manager.recover(jobId);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(submits, 1, '重试不能重新提交生成请求');
  assert.equal(manager.getResult(jobId, 0).toString(), 'recovered-bytes');
});

test('没有可复用结果时明确拒绝重下，让面板走完整重跑', async () => {
  const manager = createJobManager({
    provider: { submit: async () => ({ taskId: 'x' }), poll: async () => ({ status: 'FAILED', errorCode: 'BOOM' }) },
    sleep: async () => {},
  });
  const { jobId } = await manager.start({ operation: 'generate' });
  await settled(manager, jobId);
  await assert.rejects(() => manager.recover(jobId), { code: 'NOT_RECOVERABLE' });
  await assert.rejects(() => manager.recover('00000000-0000-0000-0000-000000000000'), { code: 'JOB_NOT_FOUND' });
});

// ── 原图对照 ──────────────────────────────────────────────────────
// 面板要拿「原图 / 生成后」做滑块对比。原图必须由服务端留：UXP 抓来的是裸 RGBA，
// 前端没有 PNG 编码器，两端各写一套必然分叉。这里守住三件事：留住了、能取、纯生成没有。
test('提交时带上的原图跟着任务留着，供面板做前后对比', async () => {
  const provider = { submit: async () => ({ taskId: 'origin-1' }), poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['u'] }), download: async () => Buffer.from('result') };
  const manager = createJobManager({ provider, sleep: async () => {} });
  const origin = Buffer.from('origin-preview-bytes');
  const { jobId } = await manager.start({ operation: 'editWhole' }, { origin });
  assert.equal(manager.get(jobId).hasOrigin, true);
  assert.equal(manager.getOrigin(jobId).toString(), 'origin-preview-bytes');
  await settled(manager, jobId);
  // 任务成功后原图还在：应用完结果还能回头看对比。
  assert.equal(manager.getOrigin(jobId).toString(), 'origin-preview-bytes');
});

test('纯生成没有底稿时明确说「没有可对比的原图」而不是给一张空图', async () => {
  const provider = { submit: async () => ({ taskId: 'origin-2' }), poll: async () => ({ status: 'SUCCEEDED', resultUrls: ['u'] }), download: async () => Buffer.from('result') };
  const manager = createJobManager({ provider, sleep: async () => {} });
  const { jobId } = await manager.start({ operation: 'generate' });
  assert.equal(manager.get(jobId).hasOrigin, false);
  assert.throws(() => manager.getOrigin(jobId), { code: 'ORIGIN_UNAVAILABLE' });
  assert.throws(() => manager.getOrigin('00000000-0000-0000-0000-000000000000'), { code: 'JOB_NOT_FOUND' });
});
