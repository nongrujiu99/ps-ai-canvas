'use strict';

const { toBase64, readFull, readBounds } = require('./imaging-adapter');
const { workArea } = require('./work-area');
const { expansionLayout, borderMask } = require('./expansion-layout');

function problem(code, message) { const error = new Error(message); error.code = code; return error; }

function createHost({ app, imaging, core, action, constants }) {
  function context(doc) {
    if (!doc) throw problem('NO_DOCUMENT', '请先打开 Photoshop 文档。');
    if (doc.mode !== constants.DocumentMode.RGB || doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT)
      throw problem('UNSUPPORTED_DOCUMENT', '首版只支持 RGB 8 位文档。');
    const bounds = doc.selection.bounds;
    return { documentId: doc.id, historyId: doc.activeHistoryState.id, width: doc.width, height: doc.height, selectionBounds: bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom } : null, colorProfile: 'sRGB IEC61966-2.1' };
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
    if (current.documentId !== snapshot.documentId || current.historyId !== snapshot.historyId || current.width !== snapshot.width || current.height !== snapshot.height || !sameSelection) {
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
    if (current.documentId !== snapshot.documentId || current.historyId !== snapshot.historyId || current.width !== snapshot.width || current.height !== snapshot.height)
      throw problem('STALE_DOCUMENT', '文档在等待期间发生变化，结果将单独打开。');
    return app.activeDocument;
  }
  async function imageData(raw, profile) {
    if (!raw || !(raw.data instanceof Uint8Array) || raw.data.length !== raw.width * raw.height * 4) throw problem('RESULT_INVALID', '结果像素无效。');
    return imaging.createImageDataFromBuffer(raw.data, { width: raw.width, height: raw.height, components: 4, colorSpace: 'RGB', colorProfile: profile || 'sRGB IEC61966-2.1' });
  }
  async function place(raw, target, capture) {
    const layer = await target.createPixelLayer({ name: capture ? capture.context.operation === 'expand' ? 'PS AI 扩图' : capture.context.operation === 'editWhole' ? 'PS AI 整图重绘' : 'PS AI 选区编辑' : 'PS AI 生成' });
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
      return { documentId: target.id, layerId: layer.id };
    } catch (error) { layer.delete(); throw error; }
  }
  async function apply(raw, capture) {
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
      }, { commandName: '应用 PS AI 扩图' });
    }
    const area = capture.context.workArea || { left: 0, top: 0, right: capture.context.width, bottom: capture.context.height };
    if (raw.width !== area.right - area.left || raw.height !== area.bottom - area.top)
      throw problem(capture.context.operation === 'expand' ? 'EXPANSION_REVIEW' : 'RESULT_SIZE', '结果尺寸与当前画布不同，将单独打开。');
    return core.executeAsModal(async () => place(raw, guard(capture.context), capture), { commandName: '应用 PS AI 结果' });
  }
  async function openSeparate(raw) {
    return core.executeAsModal(async () => {
      const doc = await app.createDocument({ width: raw.width, height: raw.height, mode: constants.NewDocumentMode.RGB, fill: constants.DocumentFill.TRANSPARENT, name: 'PS AI 结果' });
      try {
        await place(raw, doc, null);
        return { documentId: doc.id };
      } catch (error) { doc.closeWithoutSaving(); throw error; }
    }, { commandName: '打开 PS AI 结果' });
  }
  return { inspect, capture, apply, openSeparate };
}

module.exports = { createHost };
