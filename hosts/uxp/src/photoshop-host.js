'use strict';

const { toBase64, readFull, readBounds } = require('./imaging-adapter');
const { workArea } = require('./work-area');
const { expansionLayout, borderMask } = require('./expansion-layout');

function problem(code, message) { const error = new Error(message); error.code = code; return error; }

// 扩图要靠这个范围算「原照片在画布里的位置」。alpha 反推遇到照片边缘的半透明
// 描边/投影会算偏，条带被挤成几像素，合成出一张几乎全透明的图，
// 用户看到的正是「扩图区合并后不见了」。layer.bounds 是 Photoshop 自己算的几何真值。
function layerBoundsOf(doc) {
  try {
    const layer = doc.activeLayers && doc.activeLayers[0];
    const bounds = layer && layer.bounds;
    if (!bounds) return null;
    const rect = { left: Math.round(bounds.left), top: Math.round(bounds.top), right: Math.round(bounds.right), bottom: Math.round(bounds.bottom) };
    if (!['left', 'top', 'right', 'bottom'].every((side) => Number.isFinite(rect[side]))) return null;
    if (rect.right <= rect.left || rect.bottom <= rect.top) return null;
    return rect;
  } catch (_) { return null; }
}

function createHost({ app, imaging, core, action, constants }) {
  function context(doc) {
    if (!doc) throw problem('NO_DOCUMENT', '请先打开 Photoshop 文档。');
    if (doc.mode !== constants.DocumentMode.RGB || doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT)
      throw problem('UNSUPPORTED_DOCUMENT', '首版只支持 RGB 8 位文档。');
    const bounds = doc.selection.bounds;
    return { documentId: doc.id, width: doc.width, height: doc.height, selectionBounds: bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } : null, layerBounds: layerBoundsOf(doc), colorProfile: 'sRGB IEC61966-2.1' };
  }
  function inspect() { return Promise.resolve().then(() => context(app.activeDocument)); }
  async function capture(operation, options = {}) {
    const doc = app.activeDocument;
    const snapshot = context(doc);
    if (operation === 'editMasked' && !snapshot.selectionBounds) throw problem('NO_SELECTION', '请先框选需要编辑的区域。');
    const area = operation === 'editMasked' ? workArea(doc.width, doc.height, snapshot.selectionBounds) : { left: 0, top: 0, right: doc.width, bottom: doc.height };
    const pixels = await readBounds(imaging, 'getPixels', doc, 4, area);
    let selected = null;
    if (snapshot.selectionBounds && (operation === 'editMasked' || operation === 'expand')) selected = await readFull(imaging, 'getSelection', doc, 1);
    const current = context(app.activeDocument);
    const before = snapshot.selectionBounds, after = current.selectionBounds;
    const sameSelection = before === after || before && after && ['left', 'top', 'right', 'bottom'].every((key) => before[key] === after[key]);
    // 只比「文档身份 + 画布尺寸 + 选区」。历史记录 id 不能用来判断：取消选区、
    // 切换图层都会新增一条历史，拿它做校验会把等待/读取期间的正常操作一律判成
    // 「文档已变」，结果被迫另开文档——CEP 侧就是因为这个坑反复「跳到新画布」。
    if (current.documentId !== snapshot.documentId || current.width !== snapshot.width || current.height !== snapshot.height || !sameSelection) {
      throw problem('STALE_DOCUMENT', '读取期间文档或选区发生变化，请重新生成预览。');
    }
    snapshot.operation = operation;
    snapshot.workArea = area;
    snapshot.scales = options.scales || null;
    let workSelection = selected;
    if (selected && (area.left || area.top || area.right !== doc.width || area.bottom !== doc.height)) {
      workSelection = new Uint8Array((area.right - area.left) * (area.bottom - area.top));
      for (let y = area.top; y < area.bottom; y++) workSelection.set(selected.subarray(y * doc.width + area.left, y * doc.width + area.right), (y - area.top) * (area.right - area.left));
    }
    return {
      context: snapshot,
      image: { kind: 'rgba', width: area.right - area.left, height: area.bottom - area.top, dataBase64: toBase64(pixels) },
      mask: selected ? { kind: 'gray8', width: area.right - area.left, height: area.bottom - area.top, dataBase64: toBase64(workSelection) } : null,
      selectionRaw: selected,
    };
  }
  function guard(snapshot) {
    const current = context(app.activeDocument);
    // 同上：不看历史记录 id，只看文档身份和画布尺寸。
    if (current.documentId !== snapshot.documentId || current.width !== snapshot.width || current.height !== snapshot.height)
      throw problem('STALE_DOCUMENT', '文档在等待期间发生变化，结果将单独打开。');
    return app.activeDocument;
  }
  async function imageData(raw, profile) {
    if (!raw || !(raw.data instanceof Uint8Array) || raw.data.length !== raw.width * raw.height * 4) throw problem('RESULT_INVALID', '结果像素无效。');
    return imaging.createImageDataFromBuffer(raw.data, { width: raw.width, height: raw.height, components: 4, colorSpace: 'RGB', colorProfile: profile || 'sRGB IEC61966-2.1' });
  }
  async function place(raw, target, capture) {
    const operation = capture && capture.context.operation;
    const name = operation === 'expand' ? 'AI 图像工坊 扩图' : operation === 'editWhole' ? 'AI 图像工坊 整图重绘' : operation === 'editMasked' ? 'AI 图像工坊 选区编辑' : 'AI 图像工坊 生成';
    const layer = await target.createPixelLayer({ name: name });
    try {
      const pixels = await imageData(raw, capture && capture.context.colorProfile);
      const area = capture && capture.context.workArea;
      try { await imaging.putPixels({ documentID: target.id, layerID: layer.id, imageData: pixels, ...(area ? { targetBounds: { left: area.left, top: area.top } } : {}) }); }
      finally { pixels.dispose(); }
      if (capture && capture.selectionRaw) {
        await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: layer.id }], makeVisible: false }], {});
        await action.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }], {});
        const mask = await imaging.createImageDataFromBuffer(capture.selectionRaw, { width: target.width, height: target.height, components: 1, chunky: false, colorSpace: 'Grayscale', colorProfile: 'Gray Gamma 2.2' });
        try { await imaging.putLayerMask({ documentID: target.id, layerID: layer.id, imageData: mask }); }
        finally { mask.dispose(); }
      }
      // 结果始终落在新像素图层上，原图层不动。只有扩图会带 separate：
      // 它以前是合并回原图层的，现在改成独立成层，面板需要为此说一句「原图层保持不动」；
      // 生成/选区编辑本来就是新图层，沿用旧文案即可。
      return { documentId: target.id, layerId: layer.id, layerName: name, separate: operation === 'expand', merged: false, trimmed: true };
    } catch (error) { layer.delete(); throw error; }
  }
  // 预览阶段只下载 PNG（体积小），RGBA 等到真正点「应用」时再取。
  // 多候选时用户通常只用其中一张，先把所有候选的 RGBA 都拉下来纯属浪费。
  async function resolveRaw(input) {
    return input && typeof input.loadRaw === 'function' ? input.loadRaw() : input;
  }
  async function apply(input, capture) {
    const raw = await resolveRaw(input);
    guard(capture.context);
    if (capture.context.operation === 'expand' && !capture.selectionRaw && (raw.width !== capture.context.width || raw.height !== capture.context.height)) {
      const layout = expansionLayout(capture.context, raw);
      return core.executeAsModal(async () => {
        const target = guard(capture.context);
        const prior = target.activeHistoryState;
        try {
          if (layout.left || layout.top) await target.resizeCanvas(target.width + layout.left, target.height + layout.top, constants.AnchorPosition.BOTTOMRIGHT);
          if (layout.right || layout.bottom) await target.resizeCanvas(raw.width, raw.height, constants.AnchorPosition.TOPLEFT);
          const selected = borderMask(raw.width, raw.height, capture.context.width, capture.context.height, layout.left, layout.top);
          return await place(raw, target, { context: capture.context, selectionRaw: selected });
        } catch (error) {
          try { target.activeHistoryState = prior; }
          catch { throw problem('ROLLBACK_FAILED', '扩图回退失败，请检查当前文档的历史记录。'); }
          throw error;
        }
      }, { commandName: '应用 AI 图像工坊 扩图' });
    }
    const area = capture.context.workArea || { left: 0, top: 0, right: capture.context.width, bottom: capture.context.height };
    if (raw.width !== area.right - area.left || raw.height !== area.bottom - area.top)
      throw problem(capture.context.operation === 'expand' ? 'EXPANSION_REVIEW' : 'RESULT_SIZE', '结果尺寸与当前画布不同，将单独打开。');
    return core.executeAsModal(async () => place(raw, guard(capture.context), capture), { commandName: '应用 AI 图像工坊 结果' });
  }
  async function openSeparate(input) {
    const raw = await resolveRaw(input);
    return core.executeAsModal(async () => {
      const doc = await app.createDocument({ width: raw.width, height: raw.height, mode: constants.NewDocumentMode.RGB, fill: constants.DocumentFill.TRANSPARENT, name: 'AI 图像工坊 结果' });
      try {
        await place(raw, doc, null);
        return { documentId: doc.id };
      } catch (error) { doc.closeWithoutSaving(); throw error; }
    }, { commandName: '打开 AI 图像工坊 结果' });
  }
  return { inspect, capture, apply, openSeparate };
}

module.exports = { createHost };
