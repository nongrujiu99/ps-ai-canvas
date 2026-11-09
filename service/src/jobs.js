'use strict';

const { randomUUID } = require('node:crypto');
const { problem } = require('./contract');

function createJobManager({ provider, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollIntervalMs = 3000, timeoutMs = 180000 } = {}) {
  if (!provider || typeof provider.submit !== 'function' || typeof provider.poll !== 'function') {
    throw problem('INVALID_PROVIDER', '图像服务未配置。');
  }
  const jobs = new Map();

  function publicState(job) {
    return { jobId: job.id, status: job.status, resultCount: job.status === 'succeeded' ? job.results.length : 0, errorCode: job.errorCode };
  }

  async function run(job, request) {
    try {
      const submitted = await provider.submit(request);
      job.remoteId = submitted.taskId;
      if (job.cancelled) return;
      job.status = 'running';
      while (!job.cancelled) {
        if (now() - job.startedAt >= timeoutMs) {
          job.status = 'failed';
          job.errorCode = 'TASK_TIMEOUT';
          return;
        }
        const poll = await provider.poll(job.remoteId);
        if (job.cancelled) return;
        if (poll.status === 'SUCCEEDED') {
          if (!Array.isArray(poll.resultUrls) || poll.resultUrls.length === 0) {
            throw problem('EMPTY_RESULT', '任务未返回结果。');
          }
          const results = [];
          for (const url of poll.resultUrls) results.push(await provider.download(url));
          if (job.cancelled) return;
          job.results = results;
          job.status = 'succeeded';
          return;
        }
        if (!['PENDING', 'RUNNING'].includes(poll.status)) {
          job.status = 'failed';
          job.errorCode = /^[A-Za-z0-9_]{1,64}$/.test(poll.errorCode || '') ? poll.errorCode : 'TASK_FAILED';
          return;
        }
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      if (!job.cancelled) {
        job.status = 'failed';
        job.errorCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(error && error.code || '') ? error.code : 'TASK_FAILED';
        job.results = [];
      }
    }
  }

  async function start(request) {
    const id = randomUUID();
    const job = { id, status: 'pending', results: [], errorCode: null, startedAt: now(), cancelled: false, remoteId: null };
    jobs.set(id, job);
    void run(job, request);
    return { jobId: id, status: job.status };
  }

  function get(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw problem('JOB_NOT_FOUND', '找不到任务。');
    return publicState(job);
  }

  function getResult(jobId, index) {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'succeeded' || !Number.isInteger(index) || !job.results[index]) {
      throw problem('RESULT_UNAVAILABLE', '结果尚不可用。');
    }
    return job.results[index];
  }

  function cancelWait(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw problem('JOB_NOT_FOUND', '找不到任务。');
    if (job.status === 'pending' || job.status === 'running') {
      job.cancelled = true;
      job.status = 'cancelled';
    }
    return publicState(job);
  }

  return { start, get, getResult, cancelWait };
}

module.exports = { createJobManager };
