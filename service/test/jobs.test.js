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

test('provider failure text containing a key is redacted from public job state', async () => {
  const manager = createJobManager({ provider: { submit: async () => { throw new Error('sk-very-secret-key failed'); }, poll: async () => ({ status: 'PENDING', resultUrls: [] }) } });
  const { jobId } = await manager.start({ operation: 'generate' });
  const job = await settled(manager, jobId);
  assert.equal(job.status, 'failed');
  assert.equal(JSON.stringify(job).includes('sk-very-secret-key'), false);
});
