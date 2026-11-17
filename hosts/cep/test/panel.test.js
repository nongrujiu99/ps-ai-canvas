const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../js/panel');

function fake() {
  const calls = [];
  const host = { capture: async (operation) => { calls.push(['capture', operation]); return { image: { kind: 'encoded', dataUrl: 'data:image/png;base64,AA==' }, mask: { kind: 'encoded', dataUrl: 'data:image/png;base64,AA==' }, context: { documentId: 1, operation } }; }, apply: async () => ({ layerId: 2 }), openSeparate: async () => ({ documentId: 3 }) };
  const service = { inspect: async () => ({ selectionKind: 'inside' }), start: async (job) => { calls.push(['start', job]); return { jobId: 'job-1' }; }, get: async () => ({ status: 'succeeded', resultCount: 1 }), result: async () => 'data:image/png;base64,AA==', cancel: async () => ({ status: 'cancelled' }) };
  return { calls, host, service };
}

test('masked fill defaults to one candidate and allows an empty prompt', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {} });
  controller.setMode('edit');
  await controller.run({ prompt: '' });
  assert.equal(calls[1][1].operation, 'editMasked');
  assert.equal(calls[1][1].n, 1);
  assert.equal(controller.state().status, 'preview');
  assert.equal(calls.filter((x) => x[0] === 'start').length, 1);
});

test('manual transparent-border selection routes into expansion', async () => {
  const { calls, host, service } = fake();
  service.inspect = async () => ({ selectionKind: 'transparentBorder' });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  assert.equal(calls[1][1].operation, 'expand');
  assert.ok(calls[1][1].mask);
});

test('missing or ambiguous selection refuses a billable request', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {} });
  service.inspect = async () => ({ selectionKind: 'ambiguous' });
  await assert.rejects(controller.run({ mode: 'edit' }), { code: 'AMBIGUOUS_SELECTION' });
  assert.equal(calls.filter((x) => x[0] === 'start').length, 0);
});

test('generation and whole repaint require a user description', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(controller.run({ mode: 'generate', prompt: '' }), { code: 'PROMPT_REQUIRED' });
  await assert.rejects(controller.run({ mode: 'edit', whole: true, prompt: '' }), { code: 'PROMPT_REQUIRED' });
  assert.equal(calls.length, 0);
});

test('a failed job shows the reason the service sent, not a generic line', async () => {
  // 服务端现在会带 errorMessage（里面有超时秒数、接口原文）。以前面板把它丢掉，
  // 一律显示「生成任务未完成」，用户既不知道是自己填错了还是网络慢。
  const { host, service } = fake();
  service.get = async () => ({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT', errorMessage: '生成超时：接口 300 秒内没有返回结果。' });
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(
    controller.run({ mode: 'edit', prompt: '' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.match(error.message, /300 秒/);
      return true;
    }
  );
});

test('a failed job without a message falls back to a readable hint for its code', async () => {
  const { host, service } = fake();
  service.get = async () => ({ status: 'failed', errorCode: 'NO_EXPAND_AREA' });
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(controller.run({ mode: 'edit', prompt: '' }), /画布/);
});

test('a blank expansion points at the prompt box instead of pretending it worked', async () => {
  // 扩展区一片空白时，服务端会带 EXPAND_FLAT 回来。用户看到「已加入新图层」才是最糟的，
  // 所以这条提示必须告诉他下一步能改什么（画面描述 / 扩图比例）。
  const { host, service } = fake();
  service.get = async () => ({ status: 'failed', errorCode: 'EXPAND_FLAT' });
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(
    controller.run({ mode: 'edit', prompt: '' }),
    (error) => {
      assert.equal(error.code, 'EXPAND_FLAT');
      assert.match(error.message, /画面描述/);
      assert.match(error.message, /扩图比例/);
      return true;
    }
  );
});

test('a repainted frame is delivered with an explanation, not swallowed as a failure', async () => {
  // 「内容还是接不上」曾经是三连败：每次模型都画了东西（只是整张重画），
  // 服务端每次都在最后一次尝试后报错退出，PS 里右边始终是空棋盘格。
  // 现在「画了但不理想」照常出图，原因由 notice 带回来，面板必须把它显示出来。
  const { host, service } = fake();
  service.get = async () => ({
    status: 'succeeded',
    resultCount: 1,
    notice: '这次的延伸区是模型按「整体重新构图」画的，不是贴着原照片补的：颜色和光线已经对齐过，但结构可能还是接不太上。'
  });
  const controller = createController({ host, service, wait: async () => {} });
  const previews = await controller.run({ mode: 'edit', prompt: '' });
  assert.equal(previews.length, 1, '有内容就必须给出预览，不能空手而归');
  assert.equal(controller.state().status, 'preview');
  assert.match(controller.state().message, /重新构图/, '要说清为什么接不上');
  assert.match(controller.state().message, /注意/, '这是警告，不是普通提示');
});

test('an upstream outage falls back to a hint that tells the user to retry', async () => {
  // 中转站的原文是 "10k pool upstream unavailable"，对用户零信息量。
  // 老版本服务不带 errorMessage 时，至少要让面板自己说清楚「等一会儿重试」。
  const { host, service } = fake();
  service.get = async () => ({ status: 'failed', errorCode: 'PROVIDER_UPSTREAM' });
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(
    controller.run({ mode: 'edit', prompt: '' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UPSTREAM');
      assert.match(error.message, /上游/);
      // 兜底话术不能让用户以为插件「试都没试」：服务端已经自动轮过几次池子。
      assert.match(error.message, /自动重试/);
      assert.match(error.message, /再点一次/);
      return true;
    }
  );
});

test('extra candidates need confirmation and a failed network call leaves controls ready', async () => {
  const { calls, host, service } = fake();
  const controller = createController({ host, service, wait: async () => {}, confirmCost: () => false });
  await assert.rejects(controller.run({ mode: 'generate', prompt: '花瓶', n: 2 }), { code: 'COST_DECLINED' });
  service.start = async () => { throw new Error('offline'); };
  await assert.rejects(controller.run({ mode: 'generate', prompt: '花瓶' }), /offline/);
  assert.equal(controller.state().status, 'error');
  assert.equal(calls.length, 0);
});

test('accepting a changed document opens the chosen result separately', async () => {
  const { host, service } = fake();
  host.apply = async () => { const e = new Error('changed'); e.code = 'STALE_DOCUMENT'; throw e; };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  const result = await controller.accept(0);
  // 回退到「单独打开」时必须把原因带回来，界面才有办法告诉用户为什么没贴回原文档
  assert.deepEqual(result, { documentId: 3, fallbackReason: 'changed' });
});

test('a normal expand lands on its own layer and the panel says the original is untouched', async () => {
  // 扩图不再合并回原图层：结果单独成层，原图一个像素都不动。
  // 界面必须把这件事说清楚，否则用户会以为「没合并 = 出错了」。
  const { host, service } = fake();
  host.apply = async () => ({ layerId: 2, layerName: 'AI 图像工坊 扩图', separate: true, merged: false, trimmed: true, operation: 'expand', trimReason: '' });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  await controller.accept(0);
  const message = controller.state().message;
  assert.match(message, /AI 图像工坊 扩图/);
  assert.match(message, /原图层保持不动/);
});

test('when the strip cannot be aligned, the panel explains it in plain words instead of dumping coordinates', async () => {
  // bridge 带回来的原因是 `align want=2047,0 got=300,120 size=571x2560` 这种排查用语。
  // 用户看到的必须是「结果没能摆到正确的位置」，而不是一串坐标。
  const { host, service } = fake();
  host.apply = async () => ({ layerId: 2, layerName: 'AI 图像工坊 扩图（未对齐）', separate: true, merged: false, trimmed: true, operation: 'expand', trimReason: 'align want=2047,0 got=300,120 size=571x2560' });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  await controller.accept(0);
  const message = controller.state().message;
  assert.match(message, /没能摆到正确的位置/);
  assert.doesNotMatch(message, /want=/, '内部坐标不能出现在界面文案里');
});

test('when nothing could be placed at all, the panel names the reason instead of claiming a new document', async () => {
  // 旧文案在这种情况会说「结果已在新文档中打开」，但实际什么都没打开。
  const { host, service } = fake();
  host.apply = async () => ({ layerId: null, merged: false, trimmed: false, operation: 'expand', trimReason: 'full-canvas inner=0,0,2618,2560' });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });
  await controller.accept(0);
  const message = controller.state().message;
  assert.match(message, /没有贴回画布/);
  assert.doesNotMatch(message, /新文档/);
});

test('stopping a running job keeps late poll results out of the preview', async () => {
  const { host, service } = fake();
  let finishPoll;
  service.get = () => new Promise((resolve) => { finishPoll = resolve; });
  const controller = createController({ host, service, wait: async () => {} });
  const running = controller.run({ mode: 'generate', prompt: '花瓶' });
  while (!finishPoll) await new Promise((resolve) => setImmediate(resolve));
  await controller.cancel();
  finishPoll({ status: 'succeeded', resultCount: 1 });
  await running;
  assert.equal(controller.state().status, 'cancelled');
  assert.deepEqual(controller.state().previews, []);
});

function expandFake(inspection) {
  const calls = [];
  const host = {
    capture: async (operation) => {
      calls.push(['capture', operation]);
      return {
        image: { kind: 'encoded', dataUrl: 'data:image/png;base64,AA==' },
        mask: null,
        // Photoshop 给的原图层范围，扩图必须原样带给服务端
        context: { documentId: 1, operation, layerBounds: { left: 0, top: 0, right: 2000, bottom: 2560 } }
      };
    },
    apply: async () => ({ layerId: 2 }), openSeparate: async () => ({ documentId: 3 }), dispose: () => {}
  };
  const service = {
    inspect: async () => inspection,
    start: async (job) => { calls.push(['start', job]); return { jobId: 'job-1' }; },
    get: async () => ({ status: 'succeeded', resultCount: 1 }),
    result: async () => 'data:image/png;base64,AA==',
    cancel: async () => ({ status: 'cancelled' })
  };
  return { calls, host, service };
}

test('the photo bounds from Photoshop are forwarded with the job', async () => {
  // 服务端靠这个范围算「哪块是新增区」。不传的话它只能分析 alpha 反推，
  // 照片边缘有半透明就会算偏，扩图区最后贴出来是一片透明。
  const { calls, host, service } = expandFake({ selectionKind: 'none' });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1.4, bottom: 1, left: 1 } });
  const job = calls.find((x) => x[0] === 'start')[1];
  assert.deepEqual(job.canvasBounds, { left: 0, top: 0, right: 2000, bottom: 2560 });
});

test('a pixel count typed into an expansion field is rejected with a readable reason', async () => {
  // 有人会把「画布向右扩了 1398 像素」直接填进倍率框，界面看着像是填对了。
  // 这种值必须当场说清楚，而不是发出去再报一句看不懂的比例错误。
  const { calls, host, service } = expandFake({ selectionKind: 'none' });
  const controller = createController({ host, service, wait: async () => {} });
  await assert.rejects(
    controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1398, bottom: 1, left: 1 } }),
    (error) => error.code === 'INVALID_SCALE' && /倍率/.test(error.message)
  );
  assert.equal(calls.filter((x) => x[0] === 'start').length, 0);
});

test('a derived scale overrides a bogus manual number instead of failing', async () => {
  // 画布透明边能推出比例时，用户填的数字本来就不会被使用，这时不该报错。
  const { calls, host, service } = expandFake({ selectionKind: 'none', expandScales: { top: 1, right: 1.432, bottom: 1, left: 1 } });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1398, bottom: 1, left: 1 } });
  const job = calls.find((x) => x[0] === 'start')[1];
  assert.equal(job.canvasBounds.right, 2000);
  assert.equal(controller.state().status, 'preview');
});

test('derived expansion submits the inspected photo bounds, not the active transparent strip', async () => {
  // 真实事故：界面倍率已经显示「下 1.111」，但 job.canvasBounds 仍来自活动图层
  // {0,2559,2048,2844}。模型因此生成上方 2560px，最后却把另一块贴到底部，出现竖条。
  const { calls, host, service } = expandFake({
    selectionKind: 'none',
    expandScales: { top: 1, right: 1, bottom: 1.111, left: 1 },
    expandBounds: { left: 0, top: 0, right: 2048, bottom: 2560 }
  });
  host.capture = async (operation) => ({
    image: { kind: 'encoded', dataUrl: 'data:image/png;base64,AA==' }, mask: null,
    context: { documentId: 1, operation, layerBounds: { left: 0, top: 2559, right: 2048, bottom: 2844 } }
  });
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'expand', prompt: '', scales: { top: 1, right: 1, bottom: 1.111, left: 1 } });
  const job = calls.find((x) => x[0] === 'start')[1];
  assert.deepEqual(job.canvasBounds, { left: 0, top: 0, right: 2048, bottom: 2560 });
});

// ── 「图出来了但下载失败」不该再花一次钱 ────────────────────────────────
// 11 月 12 日那次：生成成功、上传成功、模型也返回了，结果图在图床上，下载时连续
// 5 次 ECONNRESET，任务标成 RESULT_DOWNLOAD 失败。面板的「重试」走的是完整重跑——
// 重新上传、重新等模型、重新计费，就为了拿一张已经存在的图。这笔钱不该用户出。
test('下载失败后点「重试」只重新下载，不重新生成', async () => {
  const { calls, host, service } = fake();
  let recovered = 0;
  let phase = 'fail';
  service.get = async () => (phase === 'fail'
    ? { status: 'failed', errorCode: 'RESULT_DOWNLOAD', errorMessage: '无法下载结果图像（ECONNRESET），已重试 8 次。' }
    : { status: 'succeeded', resultCount: 1 });
  service.recover = async () => { recovered += 1; phase = 'ok'; return { status: 'succeeded' }; };
  const controller = createController({ host, service, wait: async () => {} });

  await assert.rejects(controller.run({ mode: 'edit', prompt: '' }), (error) => error.code === 'RESULT_DOWNLOAD');
  await controller.run({ mode: 'edit', prompt: '' });

  assert.equal(recovered, 1, '重试要走「只重下」那条路');
  assert.equal(calls.filter((x) => x[0] === 'start').length, 1, '不能重新提交生成请求');
  assert.equal(controller.state().status, 'preview');
});

test('结果链接过期时退回完整重跑，而不是把用户卡在错误上', async () => {
  const { calls, host, service } = fake();
  let phase = 'fail';
  service.get = async () => (phase === 'fail'
    ? { status: 'failed', errorCode: 'RESULT_DOWNLOAD', errorMessage: '无法下载结果图像（ECONNRESET）。' }
    : { status: 'succeeded', resultCount: 1 });
  // 服务端重启过、或者超过十分钟链接失效了：这条路走不通，只能重跑。
  service.recover = async () => { const error = new Error('这次没有可以复用的结果，需要重新生成。'); error.code = 'NOT_RECOVERABLE'; throw error; };
  const controller = createController({ host, service, wait: async () => {} });

  await assert.rejects(controller.run({ mode: 'edit', prompt: '' }), (error) => error.code === 'RESULT_DOWNLOAD');
  phase = 'ok';
  await controller.run({ mode: 'edit', prompt: '' });

  assert.equal(calls.filter((x) => x[0] === 'start').length, 2, '链接失效时要重新生成');
  assert.equal(controller.state().status, 'preview', '别把「路走不通」当成「又失败了」');
});

// ── 原图对照 ──────────────────────────────────────────────────────────
// 面板点开结果后要能做「原图 ↔ 生成后」滑块的对比，所以原图必须和结果一起进 state。
// 但取原图失败不能把整次生成判成失败——纯生成本来就没有底稿。
test('结果回来时把原图一起拿上，供滑块对比', async () => {
  const { host, service } = fake();
  service.get = async () => ({ status: 'succeeded', resultCount: 2, hasOrigin: true });
  let asked = 0;
  service.origin = async (id) => { asked++; assert.equal(id, 'job-1'); return 'data:image/png;base64,ORIGIN'; };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });

  const state = controller.state();
  assert.equal(state.status, 'preview');
  assert.equal(state.previews.length, 2, '原图不能混进候选列表');
  assert.equal(state.origin, 'data:image/png;base64,ORIGIN');
  assert.equal(asked, 1, '原图只取一次');
});

test('没有原图的任务（纯生成）不去要图，也不会因此失败', async () => {
  const { host, service } = fake();
  service.get = async () => ({ status: 'succeeded', resultCount: 1, hasOrigin: false });
  let asked = 0;
  service.origin = async () => { asked++; return 'data:image/png;base64,ORIGIN'; };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });

  assert.equal(asked, 0);
  assert.equal(controller.state().origin, null);
  assert.equal(controller.state().status, 'preview');
});

test('原图取失败只是没有对比图，结果照常可用', async () => {
  const { host, service } = fake();
  service.get = async () => ({ status: 'succeeded', resultCount: 1, hasOrigin: true });
  service.origin = async () => { throw new Error('连接中断'); };
  const controller = createController({ host, service, wait: async () => {} });
  await controller.run({ mode: 'edit', prompt: '' });

  const state = controller.state();
  assert.equal(state.status, 'preview', '一张对比图不该把整次生成判成失败');
  assert.equal(state.previews.length, 1);
  assert.equal(state.origin, null);
});

test('多批生成结果存入会话历史，navHistory 可以在批次间回溯', async () => {
  const { host, service } = fake();
  let count = 0;
  service.result = async (jobId, idx) => `data:image/png;base64,P${++count}`;
  const controller = createController({ host, service, wait: async () => {} });

  await controller.run({ mode: 'edit', prompt: '第一批' });
  assert.equal(controller.state().historyCount, 1);
  assert.equal(controller.state().historyIndex, 0);
  assert.equal(controller.state().previews[0], 'data:image/png;base64,P1');

  await controller.run({ mode: 'edit', prompt: '第二批' });
  assert.equal(controller.state().historyCount, 2);
  assert.equal(controller.state().historyIndex, 1);
  assert.equal(controller.state().previews[0], 'data:image/png;base64,P2');

  // 回溯到上一批
  controller.navHistory(-1);
  assert.equal(controller.state().historyIndex, 0);
  assert.equal(controller.state().previews[0], 'data:image/png;base64,P1');

  // 切回最新一批
  controller.navHistory(1);
  assert.equal(controller.state().historyIndex, 1);
  assert.equal(controller.state().previews[0], 'data:image/png;base64,P2');
});

test('应用结果后会话历史清空，避免再应用到已释放的旧批次', async () => {
  // 结果已经落进 PS，historyList 里那些 capture 指向的是已被 dispose 的对象；
  // 继续留在历史里，navHistory 切回去点「应用」就会拿一个失效 capture 去贴回。
  const { host, service } = fake();
  let count = 0;
  service.result = async () => `data:image/png;base64,P${++count}`;
  const controller = createController({ host, service, wait: async () => {} });

  await controller.run({ mode: 'edit', prompt: '第一批' });
  await controller.run({ mode: 'edit', prompt: '第二批' });
  assert.equal(controller.state().historyCount, 2, '应用前有两批');

  await controller.accept(0);
  assert.equal(controller.state().status, 'applied');
  assert.equal(controller.state().historyCount, 0, '应用后历史必须清空');
  assert.equal(controller.state().historyIndex, -1);
  // 历史清空后 navHistory 应是无操作，不能把旧 previews 又翻回来。
  controller.navHistory(-1);
  assert.equal(controller.state().historyIndex, -1);
  assert.equal(controller.state().status, 'applied');
});
