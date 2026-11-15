(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioPanel = api;
}(this, function () {
  'use strict';

  // 这是 CEP 与 UXP 共用的面板控制器：两端各存一份副本（CEP 用 <script> 加载、
  // UXP 用 require，打包结构不同），内容必须完全一致，由 panel-parity.test.js 保证。
  //
  // 存在的理由：这两份以前是各自演化的，结果 UXP 那份丢了「向服务端要推导比例」
  // 「用推导值覆盖手填值」「扩图失败给坐标指引」「临时文件回收」这些行为。
  // 表现是同一个操作在两端结果不同，而且 UXP 那边错得静默——用户按默认倍率
  // 点了扩图，服务端照做，生成一张方向错的图，过程中一句提示都没有。
  // 只要还有两份实现，这种分叉就会重新长出来，所以合并成一份。
  //
  // 对 host 的约定（两端适配器各自实现）：
  //   capture(operation, settings) -> { image, mask, context, maskPath?, workMaskPath? }
  //   apply(preview, capture) -> { documentId, layerId?, merged?, trimmed?, ... }
  //   openSeparate(preview) -> { documentId }
  //   dispose?(capture)
  //   inspect?() -> context
  // preview 是 service.result() 的返回值，控制器不解释它的结构，只负责回传给 host。

  function issue(code, message) { var error = new Error(message); error.code = code; return error; }

  // 没合并成功时，bridge 会把「卡在哪一步」以 `align want=… got=…` 这种形式带回来。
  // 那是给排查用的，不能原样丢给用户。这里翻译成人话；对不上就原样显示，
  // 至少不会把原因吞掉。
  var TRIM_REASONS = [
    [/^merge-lost/, '合并后原图层没有变化，像素没能并进去'],
    [/^align/, '结果没能摆到正确的位置'],
    [/^full-result/, '模型重画了整张画面，不只是边缘'],
    [/^merge-failed/, '原图层不是普通像素层，无法合并'],
    [/^no-inner/, '看不出原图在画布上的范围'],
    [/^full-canvas/, '画布上没有可以扩展的区域'],
    [/^place/, '无法把结果放进当前文档']
  ];

  function explainTrimReason(reason) {
    var text = String(reason || '');
    for (var i = 0; i < TRIM_REASONS.length; i++) {
      if (TRIM_REASONS[i][0].test(text)) return TRIM_REASONS[i][1];
    }
    return text;
  }

  // 服务端现在会带 errorMessage 回来，正常情况下直接用它（里面有尺寸、超时秒数这类
  // 只有服务端知道的信息）。这张表只是兜底：老版本服务、或错误在传输中被截断时，
  // 至少别退化成一句「生成任务未完成」。
  var FAILURE_HINTS = {
    PROVIDER_TIMEOUT: '生成超时：接口很久没有返回。画布越大越慢，可以调小扩图比例，或在设置里换更快的渠道。',
    PROVIDER_NETWORK: '连不上图像接口，请检查设置里的服务地址和本机网络。',
    PROVIDER_REQUEST_FAILED: '图像接口拒绝了这次请求，原因见服务窗口日志。',
    PROVIDER_UPSTREAM: '图像服务上游暂时不可用（中转站侧的临时故障，不是你的配置问题）。插件会自动重试几轮；仍然失败就等半分钟再点一次，或换一个模型。',
    PROVIDER_RESPONSE: '图像接口返回的内容无法识别，可能不是 OpenAI 兼容格式。',
    SIZE_REJECTED: '接口不接受这个输出尺寸，请换一个模型或调整画布大小。',
    NO_EXPAND_AREA: '画布上看不出「原图 + 透明扩展区」，请先把画布拉大再试。',
    // 渠道把留白底稿原样交回来（请求成功、图也回来了，但扩展区一个像素都没重绘）。
    // 这种情况下给用户看「生成成功」才是最大的误导，必须直说。
    // 注意：这只覆盖「什么都没画」。「画了但接不上」不再走报错——服务端会照常出图，
    // 把毛病写在 notice 里带回来（见下面的提示语），让用户自己看图判断。
    EXPAND_FLAT: '这次扩展区是空的：三种请求方式都试过，模型始终没有把延伸区画成内容。可以在「画面描述」里写一句希望延伸出来的东西（例如「右边接着白墙和木地板」）再试，或把扩图比例调小。',
    TASK_TIMEOUT: '等待超时，任务已停止。',
    CHANNEL_NOT_CONFIGURED: '还没配置生成渠道，请打开设置页填写后再试。',
    MISSING_API_KEY: '还没填 API Key，请打开设置页填写。',
    EMPTY_RESULT: '接口没有返回图像。'
  };

  function failureMessage(job) {
    if (job.errorMessage) return job.errorMessage;
    if (job.errorCode && FAILURE_HINTS[job.errorCode]) return FAILURE_HINTS[job.errorCode];
    return '生成任务未完成。' + (job.errorCode ? '（' + job.errorCode + '）' : '');
  }

  function createController(options) {
    var host = options.host, service = options.service;
    var wait = options.wait || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
    var confirmCost = options.confirmCost || function () { return true; };
    var notify = options.notify || function () {};
    var state = { mode: 'edit', status: 'idle', message: '', previews: [], origin: null, jobId: null, capture: null, errorCode: '' };
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
          // 原图和结果一起取：面板要用它做滑块对比（点开图片看前后差别）。
          // 取不到不算失败——纯生成本来就没有底稿，服务端会拒绝；这时候只显示单图，
          // 不能让一张对比图把整次生成判成失败。
          var wantsOrigin = !!job.hasOrigin && typeof service.origin === 'function';
          if (wantsOrigin) tasks.push(service.origin(jobId).catch(function () { return null; }));
          // 种子跟着结果一起显示：留空时是服务端摇的，不说出来的话「这张不错、再出一遍」
          // 就永远做不到——而这张模型的种子是真生效的。
          var seedNote = job.seed === undefined || job.seed === null ? '' : ' · 种子 ' + job.seed;
          return Promise.all(tasks).then(function (previews) { var origin = wantsOrigin ? previews.pop() : null; if (state.status === 'cancelled') return; change({ status: 'preview', previews: previews, origin: origin, message: '选择满意的结果后应用。' + seedNote + (job.notice ? '注意：' + job.notice : '') }); return previews; });
        }
        if (job.status === 'failed' || job.status === 'cancelled') throw issue(job.errorCode || 'JOB_FAILED', job.status === 'cancelled' ? '任务已取消。' : failureMessage(job));
        return wait(1200).then(function () { return poll(jobId); });
      });
    }
    // 扩图失败时给出可执行的坐标指引，而不是笼统的“选区不适合”。
    function expansionHint(inspection) {
      var t = inspection.transparentBounds, s = inspection.selectionBounds;
      if (!t) return '当前画面没有透明区域。请先用「图像 → 画布大小」扩大画布，再框选新出现的透明棋盘格。';
      var width = t.right - t.left, height = t.bottom - t.top;
      var vertical = height >= width;
      var region = vertical
        ? '透明区在 x ' + t.left + ' ~ ' + t.right + '（宽 ' + width + ' 像素）'
        : '透明区在 y ' + t.top + ' ~ ' + t.bottom + '（高 ' + height + ' 像素）';
      var mine = '';
      if (s) {
        mine = vertical
          ? '你的选区在 x ' + s.left + ' ~ ' + s.right + '，'
          : '你的选区在 y ' + s.top + ' ~ ' + s.bottom + '，';
      }
      return mine + region + '。请用矩形选框只框住透明区，不要框到照片内容。';
    }
    function run(input) {
      input = input || {};
      // 「结果下载失败」的重试走另一条路：图已经画好了、就在图床 CDN 上，只是没拉回来。
      // 完整重跑要重新上传、重新等模型、重新计费——为了拿一张已经存在的图付第二遍钱，
      // 这是最不该发生的事（11 月 12 日那次 71 秒的失败就是这么来的）。
      if (state.status === 'error' && state.errorCode === 'RESULT_DOWNLOAD' && state.jobId && service.recover) {
        return recoverRun(input);
      }
      return beginRun(input);
    }
    function recoverRun(input) {
      var jobId = state.jobId;
      change({ status: 'running', message: '图已经生成好了，正在重新下载…', errorCode: '' });
      return service.recover(jobId).then(function () {
        if (state.status === 'cancelled') return;
        return poll(jobId);
      }).catch(function (error) {
        if (state.status === 'cancelled') return;
        // 结果链接已经过期、或者服务端重启过把任务忘了：那就只能完整重跑一次。
        // 这几种情况是「这条路走不通」，不是「又失败了」，不该把错误甩给用户。
        if (/^(NOT_RECOVERABLE|JOB_NOT_FOUND|RESULT_UNAVAILABLE)$/.test((error && error.code) || '')) {
          return beginRun(input);
        }
        change({ status: 'error', message: error.message || '重新下载失败。', errorCode: (error && error.code) || '' });
        throw error;
      });
    }
    function beginRun(input) {
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
      change({ mode: mode, status: 'preparing', message: '正在检查 Photoshop 画面…', previews: [], origin: null, capture: null, jobId: null });
      var activeCapture = null;
      var capturePromise = mode === 'generate' ? Promise.resolve(null) : host.capture(whole ? 'editWhole' : mode === 'expand' ? 'expand' : 'editMasked', { scales: input.scales || { top: 1, right: 1, bottom: 1, left: 1 } });
      return capturePromise.then(function (capture) {
        activeCapture = capture;
        if (mode === 'generate' || whole) return { capture: capture, operation: mode === 'generate' ? 'generate' : 'editWhole' };
        if (!capture.mask) {
          if (mode === 'edit') throw issue('NO_SELECTION', '请先框选需要编辑的区域。');
          // 没有选区也要问服务端：画布上的透明边能把「往哪扩、扩多少」算得很准，
          // 比方向滑块靠猜靠谱得多（滑块和画布实际尺寸经常对不上）。
          return service.inspect({ image: capture.image, context: capture.context }).then(function (inspection) {
            if (inspection.expandScales) return { capture: capture, operation: 'expand', useMask: false, scales: inspection.expandScales, scalesDerived: true, expandBounds: inspection.expandBounds };
            return { capture: capture, operation: 'expand', useMask: false, scales: input.scales };
          });
        }
        return service.inspect({ image: capture.image, mask: capture.mask, context: capture.context }).then(function (inspection) {
          if (inspection.selectionKind === 'transparentBorder') return { capture: capture, operation: 'expand', useMask: true };
          if (inspection.selectionKind === 'inside' && mode === 'edit') return { capture: capture, operation: 'editMasked', useMask: true };
          if (inspection.selectionKind === 'none' && mode !== 'expand') throw issue('NO_SELECTION', '请先框选需要编辑的区域。');
          // 扩宽模式：只要画布存在干净的透明边，就按透明边推导比例，不依赖选区是否框准。
          if (mode === 'expand' && inspection.expandScales) {
            return { capture: capture, operation: 'expand', useMask: false, scales: inspection.expandScales, scalesDerived: true, expandBounds: inspection.expandBounds };
          }
          if (inspection.selectionKind === 'ambiguous' && mode === 'edit') throw issue('AMBIGUOUS_SELECTION', '选区同时压住了照片和透明区，请只框照片内部。');
          if (mode === 'expand') throw issue('INVALID_SELECTION', '当前是「扩宽」模式，但选区没有覆盖透明区。' + expansionHint(inspection));
          throw issue('INVALID_SELECTION', '当前选区落在照片内部，适合「选区编辑」。请切到「选区编辑」后再生成。');
        });
      }).then(function (prepared) {
        var capture = prepared.capture;
        var job = { operation: prepared.operation, prompt: prompt, n: n };
        if (capture) job.image = capture.image;
        if (prepared.operation === 'editMasked' || (prepared.operation === 'expand' && prepared.useMask && capture.mask)) job.mask = capture.mask;
        if (prepared.operation === 'expand' && !job.mask) {
          job.scales = prepared.scales || input.scales || { top: 1, right: 1, bottom: 1, left: 1 };
          // 只有「最终真的会用这个手填值」时才校验：画布透明边能推出比例时，
          // 用户填什么都会被覆盖，此时报错属于误伤。反过来，一旦这组数字真被送到服务端，
          // 就必须是 1.0~2.0 的倍率——有人会照着「画布向右扩了 1398 像素」填 1398，
          // 界面上看不出问题，最后却死在一条看不懂的比例错误上。
          if (!prepared.scalesDerived) {
            var sides = { top: '上', right: '右', bottom: '下', left: '左' };
            Object.keys(sides).forEach(function (side) {
              var value = Number(job.scales[side]);
              if (!Number.isFinite(value) || value < 1 || value > 2)
                throw issue('INVALID_SCALE', sides[side] + '扩图比例是倍率，须在 1.0 到 2.0 之间（1 = 不扩，1.4 = 扩到 1.4 倍）。现在填的是 ' + job.scales[side] + '。');
            });
            // 四个方向全是 1，说明既没推出比例、也没人填：再提交上去只会得到一张
            // 「原样返回」的图，还照样计费。说清楚下一步该做什么，而不是让他自己猜。
            if (Object.keys(sides).every(function (side) { return Number(job.scales[side]) === 1; }))
              throw issue('NO_EXPANSION', '读不出画布上的透明边，四个方向都是 1，没有可扩的区域。请先在 Photoshop 里把画布往要扩的方向拉大（图像 → 画布大小），再点一次；或者直接填一个 1.0~2.0 的倍率。');
          }
        }
        // 扩图必须把「原照片在画布里的位置」明确交给服务端。服务端拿不到就只剩一条路：
        // 分析捕获 PNG 的 alpha 去反推——照片边缘只要有一圈半透明（描边、柔和投影、
        // 抗锯齿），反推出的范围就会比照片大，新增条带被挤成几个像素，返回图里只有那
        // 几列有内容，贴回去看着就是「扩图区整片透明、合并后不见了」。
        //
        // 但也不能无脑用 layer.bounds：它只是**活动图层**的范围，用户把活动层停在底部
        // 那条透明带上时，它只是画面的一角。拿它提交，模型会把上方 2560px 当成原图、
        // 把下方 284px 当成新增区，贴回来就是一条竖条纹——而界面上的倍率看着完全正确，
        // 因为倍率是服务端从另一个范围推的。所以范围必须和倍率同源：
        // 服务端推导出倍率时会一起回传它用的那个范围（expandBounds），优先用它。
        if (prepared.operation === 'expand' && capture) {
          var photoBounds = prepared.expandBounds || (capture.context && capture.context.layerBounds);
          if (photoBounds) job.canvasBounds = photoBounds;
          // 应用阶段按这个范围反解原照片矩形；它和提交时用的必须是同一个，
          // 否则「生成的那块」和「贴回的那块」会对不上。
          if (photoBounds && prepared.expandBounds && capture.context) capture.context.layerBounds = photoBounds;
        }
        if (prepared.operation === 'editWhole') job.strength = input.strength === undefined ? 0.5 : Number(input.strength);
        if (prepared.operation === 'generate') job.size = input.size || '1024*1024';
        if (input.seed !== undefined && input.seed !== '') job.seed = Number(input.seed);
        capture && (capture.context.operation = prepared.operation);
        if (capture && prepared.operation === 'expand' && !prepared.useMask) {
          capture.skipMaskApply = true;
          // 应用阶段要靠这组比例反推「原照片在最终画布里的位置」，才能把生成结果裁成
          // 只保留新增边缘并合并回原图层。所以必须带回真实比例，而不是方向滑块的值。
          capture.context.scales = job.scales;
          // 标记这组比例来自画布透明边（可信）。滑块比例和画布无关，不能拿来裁图。
          capture.context.scalesDerived = !!prepared.scalesDerived;
        }
        change({ capture: capture, status: 'submitting', message: '正在提交生成任务…', appliedScales: job.scales || null, scalesDerived: !!prepared.scalesDerived });
        return service.start(job);
      }).then(function (started) {
        change({ jobId: started.jobId, status: 'running', message: '正在生成预览…' });
        return poll(started.jobId);
      }).catch(function (error) {
        if (activeCapture && host.dispose) host.dispose(activeCapture);
        if (state.status === 'cancelled') return;
        change({ status: 'error', message: error.message || '操作失败。', errorCode: (error && error.code) || '' });
        throw error;
      });
    }
    function accept(index) {
      if (state.status !== 'preview' || !state.previews[index]) return Promise.reject(issue('NO_PREVIEW', '请先生成并选择结果。'));
      var preview = state.previews[index];
      var capture = state.capture;
      var action = !capture ? host.openSeparate(preview) : host.apply(preview, capture).catch(function (error) {
        if (['STALE_DOCUMENT', 'STALE_SELECTION', 'RESULT_SIZE', 'EXPANSION_REVIEW'].indexOf(error.code) >= 0) {
          // 贴不回原文档时不要静默另开文档，必须把原因带回界面，
          // 否则用户只会看到「怎么又跳到一个新画布」。
          return host.openSeparate(preview).then(function (result) {
            result.fallbackReason = error.message;
            return result;
          });
        }
        throw error;
      });
      return action.then(function (result) {
        if (capture && host.dispose) host.dispose(capture);
        // 把「为什么没按预期落位」带出来：扩图正常情况是单独成层（separate），
        // 但位置对不上、或结果其实是整张画面时，必须让用户知道，而不是只说一句「已加入新图层」。
        var why = '';
        if (result && !result.merged) {
          if (result.operation && result.operation !== 'expand') {
            why = '（本次操作：' + (result.operation === 'editWhole' ? '整张画面重绘'
              : result.operation === 'editMasked' ? '选区编辑'
                : result.operation === 'generate' ? '生成' : result.operation) + '）';
          } else if (result.trimmed === false) {
            why = '（未能裁出新增区域' + (result.trimReason ? '：' + explainTrimReason(result.trimReason) : '') + '）';
          } else if (result.trimmed && result.trimReason) {
            // 已经裁出新增区域但没并进原图层：多半是原图层不是普通像素层
            why = '（' + explainTrimReason(result.trimReason) + '）';
          }
        }
        var message = !result ? '结果已应用。'
          : result.fallbackReason ? '结果已单独打开（' + result.fallbackReason + '）'
            : result.merged ? '已合并到原图层，只保留新增的画面。'
              // 扩图默认走这条：结果单独成层，原图层不动。要不要合并交给用户 Ctrl+E。
              : result.separate ? '已加入新图层「' + (result.layerName || 'AI 图像工坊 扩图') + '」，原图层保持不动' + why + '。'
                : result.layerId ? '结果已加入新图层，未合并回原图层' + why + '。'
                  // 连图层都没留下来时，旧文案会说「结果已在新文档中打开」——但并没有打开任何东西，
                  // 用户只会更困惑。有原因就直接说原因。
                  : result.trimReason ? '结果没有贴回画布（' + explainTrimReason(result.trimReason) + '）。'
                    : '结果已在新文档中打开。';
        change({ status: 'applied', capture: null, message: message });
        return result;
      });
    }
    function cancel() {
      if (!state.jobId || state.status !== 'running') return Promise.resolve();
      if (state.capture && host.dispose) host.dispose(state.capture);
      change({ status: 'cancelled', message: '已停止等待；云端任务可能仍在运行。' });
      return service.cancel(state.jobId);
    }
    function dispose() { if (state.capture && host.dispose) host.dispose(state.capture); change({ capture: null }); }
    return { state: function () { return Object.assign({}, state); }, setMode: function (mode) { change({ mode: mode, scalesDerived: false }); }, run: run, accept: accept, cancel: cancel, dispose: dispose };
  }

  return { createController: createController };
}));
