'use strict';

const { randomUUID } = require('node:crypto');
const { problem } = require('./contract');

function createJobManager({ provider, providerFactory, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollIntervalMs = 3000, timeoutMs = 10 * 60 * 1000, resultTtlMs = 10 * 60 * 1000, maxJobs = 32, log = (line) => process.stderr.write(line + '\n') } = {}) {
  if (typeof providerFactory !== 'function' && (!provider || typeof provider.submit !== 'function' || typeof provider.poll !== 'function')) {
    throw problem('INVALID_PROVIDER', '图像服务未配置。');
  }
  const jobs = new Map();
  const timers = new Map();

  // 任务结果是画布尺寸的 PNG（常常每张十几 MB），而且只有「面板取结果」这一次读取。
  // 以前只 set 不 delete，一条任务占的内存到进程退出才释放，用户会感觉
  // 「用了一下午越用越卡」。这里在任务结束后挂一个定时回收，到点无条件清掉。
  function forget(id) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    jobs.delete(id);
  }

  function scheduleEviction(id) {
    const timer = setTimeout(() => forget(id), resultTtlMs);
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(id, timer);
  }

  // 兜底：即使请求一直不来取结果，任务表也不能无限增长。
  function trim() {
    if (jobs.size <= maxJobs) return;
    const finished = [...jobs.values()]
      .filter((job) => job.status !== 'pending' && job.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const job of finished) {
      if (jobs.size <= maxJobs) break;
      forget(job.id);
    }
  }

  function publicState(job) {
    // hasOrigin 让面板知道「这次有没有可比的原图」。纯生成（generate）没有底稿，
    // 面板就不该画一个拖不动的对比滑块——那比没有还糟。
    return { jobId: job.id, status: job.status, resultCount: job.status === 'succeeded' ? job.results.length : 0, errorCode: job.errorCode, errorMessage: job.errorMessage || '', notice: job.notice || '', seed: job.seed === undefined ? null : job.seed, hasOrigin: !!job.origin };
  }

  // 失败原因必须留在两个地方：面板（用户看得懂）和服务窗口（排查时看得见）。
  // 以前只存一个 errorCode，面板又把它换成「生成任务未完成」，等于什么都没说——
  // 「超时」「模型名错」「尺寸被拒」在界面上长得一模一样。
  //
  // 但错误文本来自外部接口，可能把 Authorization 回显在里面（"Incorrect API key
  // sk-xxx"）。这段文字要经 HTTP 到面板、还会写进服务窗口，所以先脱敏再存。
  function redact(text) {
    return String(text || '')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
      .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***');
  }

  function fail(job, code, message) {
    job.status = 'failed';
    job.errorCode = code;
    job.errorMessage = redact(message).replace(/\s+/g, ' ').slice(0, 300);
    job.results = [];
    // 结果链接不跟着错误一起丢：图已经在图床上了，付过钱也生成了，只是没下载回来。
    // 丢掉它等于让用户为了同一张图再花两分钟、再花一次额度。留着，下次点「重试」
    // 就能只重下（见 recover）。
    log(`[job ${job.id.slice(0, 8)}] failed ${code} after ${Math.round((now() - job.startedAt) / 1000)}s: ${job.errorMessage}`);
  }

  // 下载结果图。抽出来是为了让「首次生成」和「只重下」走同一段代码：
  // 两条路径的失败处理必须完全一样，否则又是一处会分叉的判定。
  async function collectResults(job, urls) {
    const results = [];
    for (const url of urls) results.push(await job.fetchResult(url));
    return results;
  }

  async function run(job, request) {
    try {
      log(`[job ${job.id.slice(0, 8)}] start ${request.operation || 'edit'} n=${request.n || 1}`);
      const jobProvider = providerFactory ? await providerFactory(request) : provider;
      if (!jobProvider || typeof jobProvider.submit !== 'function' || typeof jobProvider.poll !== 'function') {
        throw problem('INVALID_PROVIDER', '图像服务未配置。');
      }
      const submitted = await jobProvider.submit(request);
      job.remoteId = submitted.taskId;
      // 供应商可能为了绕过上游限制降过一档尺寸。这个事实必须跟着结果一起回面板：
      // 用户看到「图有点软」时，得知道是渠道能力上限，而不是以为自己画质设置错了。
      job.notice = submitted.notice || '';
      // 供应商实际用的种子要跟着结果回面板：留空时是服务端摇的随机数，用户只有
      // 知道这个数才能把满意的那张再出一遍。
      if (submitted.seed !== undefined) job.seed = submitted.seed;
      if (job.cancelled) return;
      job.status = 'running';
      while (!job.cancelled) {
        if (now() - job.startedAt >= timeoutMs) {
          fail(job, 'TASK_TIMEOUT', `任务超过 ${Math.round(timeoutMs / 60000)} 分钟仍未完成，已停止等待。`);
          return;
        }
        const poll = await jobProvider.poll(job.remoteId);
        if (job.cancelled) return;
        if (poll.status === 'SUCCEEDED') {
          if (!Array.isArray(poll.resultUrls) || poll.resultUrls.length === 0) {
            throw problem('EMPTY_RESULT', '任务未返回结果。');
          }
          job.resultUrls = poll.resultUrls;
          job.fetchResult = (url) => jobProvider.download(url);
          const results = await collectResults(job, job.resultUrls);
          if (job.cancelled) return;
          job.results = results;
          job.status = 'succeeded';
          job.resultUrls = null;
          job.fetchResult = null;
          log(`[job ${job.id.slice(0, 8)}] ok ${results.length} image(s) in ${Math.round((now() - job.startedAt) / 1000)}s`);
          return;
        }
        if (!['PENDING', 'RUNNING'].includes(poll.status)) {
          const code = /^[A-Za-z0-9_]{1,64}$/.test(poll.errorCode || '') ? poll.errorCode : 'TASK_FAILED';
          fail(job, code, poll.errorMessage || `图像接口返回状态 ${poll.status}。`);
          return;
        }
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      if (job.cancelled) return;
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error && error.code || '') ? error.code : 'TASK_FAILED';
      // 没有 code 的异常（比如「missing settings」）以前会静默变成 TASK_FAILED，
      // 连原因都不剩。这里退回到 message，至少让人看到是哪一步炸了。
      fail(job, code, (error && error.message) || '未知错误。');
    }
  }

  async function start(request, extra = {}) {
    const id = randomUUID();
    // origin 是提交时抓下来的「原图缩小版」，只服务于前后对比，不进 provider 请求。
    const job = { id, status: 'pending', results: [], errorCode: null, startedAt: now(), cancelled: false, remoteId: null, origin: extra.origin || null };
    jobs.set(id, job);
    void run(job, request).then(function settle() { scheduleEviction(id); trim(); });
    return { jobId: id, status: job.status };
  }

  function get(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw problem('JOB_NOT_FOUND', '找不到任务。');
    return publicState(job);
  }

  // 原图只用于对比，和结果一起随任务回收（同一个 TTL），不做单独缓存。
  function getOrigin(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw problem('JOB_NOT_FOUND', '找不到任务。');
    if (!job.origin) throw problem('ORIGIN_UNAVAILABLE', '这次没有可对比的原图（纯生成本来就没有底稿）。');
    return job.origin;
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

  // 只重下、不重生成。
  //
  // 这是被一次 71 秒的失败逼出来的：图已经生成好放在图床上了，从 `webstatic.aiproxy.vip`
  // 下载时连续五次被 ECONNRESET，任务于是标成 RESULT_DOWNLOAD 失败、结果被清空。
  // 面板上的「重试」走的是完整重跑——重新上传、重新等模型、重新计费，就为了拿一张
  // 已经存在的图。图床抖一下要付两遍钱，这显然不该发生。
  //
  // 现在失败时留住了 resultUrls 和下载函数，重试先走这条路：几秒钟的事，不花钱。
  // 链接过期或被清掉了才退回完整重跑（面板侧见 recoverThenRun）。
  async function recover(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw problem('JOB_NOT_FOUND', '找不到任务。');
    if (job.status === 'succeeded') return publicState(job);
    if (job.status === 'pending' || job.status === 'running') throw problem('JOB_BUSY', '任务还在进行中。');
    if (!Array.isArray(job.resultUrls) || job.resultUrls.length === 0 || typeof job.fetchResult !== 'function') {
      throw problem('NOT_RECOVERABLE', '这次没有可以复用的结果，需要重新生成。');
    }
    job.status = 'running';
    job.errorCode = null;
    job.errorMessage = '';
    log(`[job ${job.id.slice(0, 8)}] 只重新下载结果图，不重新生成`);
    try {
      const results = await collectResults(job, job.resultUrls);
      job.results = results;
      job.status = 'succeeded';
      job.resultUrls = null;
      job.fetchResult = null;
      log(`[job ${job.id.slice(0, 8)}] ok ${results.length} image(s)（重下成功）`);
      return publicState(job);
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error && error.code || '') ? error.code : 'TASK_FAILED';
      fail(job, code, (error && error.message) || '未知错误。');
      const failure = problem(code, job.errorMessage);
      failure.httpStatus = error && error.httpStatus;
      throw failure;
    }
  }

  return { start, get, getResult, cancelWait, recover, getOrigin, stats: () => ({ jobs: jobs.size }) };
}

module.exports = { createJobManager };
