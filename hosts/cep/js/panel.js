(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSAIPanel = factory();
}(this, function () {
  'use strict';

  function issue(code, message) { var error = new Error(message); error.code = code; return error; }

  function createController(options) {
    var host = options.host, service = options.service;
    var wait = options.wait || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    var confirmCost = options.confirmCost || function () { return true; };
    var notify = options.notify || function () {};
    var state = { mode: 'edit', status: 'idle', message: '', previews: [], jobId: null, capture: null };
    function change(patch) {
      Object.keys(patch).forEach(function (key) { state[key] = patch[key]; });
      notify(Object.assign({}, state));
    }
    function ensurePrompt(value) {
      if (!value || !value.trim()) throw issue('PROMPT_REQUIRED', '请先输入画面描述。');
    }
    function poll(jobId) {
      if (state.status === 'cancelled') return Promise.resolve();
      return service.get(jobId).then(function (job) {
        if (state.status === 'cancelled') return;
        if (job.status === 'succeeded') {
          var tasks = [];
          for (var i = 0; i < job.resultCount; i++) tasks.push(service.result(jobId, i));
          return Promise.all(tasks).then(function (previews) { if (state.status === 'cancelled') return; change({ status: 'preview', previews: previews, message: '选择满意的结果后应用。' }); return previews; });
        }
        if (job.status === 'failed' || job.status === 'cancelled') throw issue(job.errorCode || 'JOB_FAILED', '生成任务未完成。');
        return wait(1200).then(function () { return poll(jobId); });
      });
    }
    function run(input) {
      input = input || {};
      var mode = input.mode || state.mode;
      var whole = mode === 'edit' && !!input.whole;
      var prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      var n = input.n === undefined ? 1 : Number(input.n);
      try {
        if (mode === 'generate' || whole) ensurePrompt(prompt);
        if (!Number.isInteger(n) || n < 1 || n > 4) throw issue('INVALID_COUNT', '候选数量须为 1 到 4。');
        if ((n > 1 || state.status === 'preview') && !confirmCost()) throw issue('COST_DECLINED', '已取消额外生成请求。');
      } catch (error) { return Promise.reject(error); }
      if (state.capture && host.dispose) host.dispose(state.capture);
      change({ mode: mode, status: 'preparing', message: '正在检查 Photoshop 画面…', previews: [], capture: null, jobId: null });
      var activeCapture = null;
      var capturePromise = mode === 'generate' ? Promise.resolve(null) : host.capture(whole ? 'editWhole' : mode === 'expand' ? 'expand' : 'editMasked', { scales: input.scales || { top: 1, right: 1.5, bottom: 1, left: 1 } });
      return capturePromise.then(function (capture) {
        activeCapture = capture;
        if (mode === 'generate' || whole) return { capture: capture, operation: mode === 'generate' ? 'generate' : 'editWhole' };
        if (!capture.mask) {
          if (mode === 'edit') throw issue('NO_SELECTION', '请先框选需要编辑的区域。');
          return { capture: capture, operation: 'expand' };
        }
        return service.inspect({ image: capture.image, mask: capture.mask }).then(function (inspection) {
          if (inspection.selectionKind === 'ambiguous') throw issue('AMBIGUOUS_SELECTION', '选区跨越画面和透明边缘，请明确选择。');
          if (inspection.selectionKind === 'transparentBorder') return { capture: capture, operation: 'expand' };
          if (inspection.selectionKind === 'inside' && mode === 'edit') return { capture: capture, operation: 'editMasked' };
          if (inspection.selectionKind === 'none') throw issue('NO_SELECTION', '请先框选需要编辑的区域。');
          throw issue('INVALID_SELECTION', '当前选区不适合该操作。');
        });
      }).then(function (prepared) {
        var capture = prepared.capture;
        var job = { operation: prepared.operation, prompt: prompt, n: n };
        if (capture) job.image = capture.image;
        if (prepared.operation === 'editMasked' || (prepared.operation === 'expand' && capture.mask)) job.mask = capture.mask;
        if (prepared.operation === 'expand' && !capture.mask) job.scales = input.scales || { top: 1, right: 1.5, bottom: 1, left: 1 };
        if (prepared.operation === 'editWhole') job.strength = input.strength === undefined ? 0.5 : Number(input.strength);
        if (prepared.operation === 'generate') job.size = input.size || '1024*1024';
        if (input.seed !== undefined && input.seed !== '') job.seed = Number(input.seed);
        capture && (capture.context.operation = prepared.operation);
        change({ capture: capture, status: 'submitting', message: '正在提交生成任务…' });
        return service.start(job);
      }).then(function (started) {
        change({ jobId: started.jobId, status: 'running', message: '正在生成预览…' });
        return poll(started.jobId);
      }).catch(function (error) {
        if (activeCapture && host.dispose) host.dispose(activeCapture);
        if (state.status === 'cancelled') return;
        change({ status: 'error', message: error.message || '操作失败。' });
        throw error;
      });
    }
    function accept(index) {
      if (state.status !== 'preview' || !state.previews[index]) return Promise.reject(issue('NO_PREVIEW', '请先生成并选择结果。'));
      var png = state.previews[index];
      var capture = state.capture;
      var action = !capture ? host.openSeparate(png) : host.apply(png, capture).catch(function (error) {
        if (['STALE_DOCUMENT', 'STALE_SELECTION', 'RESULT_SIZE', 'EXPANSION_REVIEW'].indexOf(error.code) >= 0) return host.openSeparate(png);
        throw error;
      });
      return action.then(function (result) { if (capture && host.dispose) host.dispose(capture); change({ status: 'applied', capture: null, message: '结果已打开或加入新图层。' }); return result; });
    }
    function cancel() {
      if (!state.jobId || state.status !== 'running') return Promise.resolve();
      if (state.capture && host.dispose) host.dispose(state.capture);
      change({ status: 'cancelled', message: '已停止等待；云端任务可能仍在运行。' });
      return service.cancel(state.jobId);
    }
    function dispose() { if (state.capture && host.dispose) host.dispose(state.capture); change({ capture: null }); }
    return { state: function () { return Object.assign({}, state); }, setMode: function (mode) { change({ mode: mode }); }, run: run, accept: accept, cancel: cancel, dispose: dispose };
  }

  return { createController: createController };
}));
