'use strict';

const { toBase64, readFull } = require('./imaging-adapter');

function problem(code, message) { const error = new Error(message); error.code = code; return error; }

function createHost({ app, imaging, core, action, constants }) {
  function context(doc) {
    if (!doc) throw problem('NO_DOCUMENT', '请先打开 Photoshop 文档。');
    if (doc.mode !== constants.DocumentMode.RGB || doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT)
      throw problem('UNSUPPORTED_DOCUMENT', '首版只支持 RGB 8 位文档。');
    return { documentId: doc.id, historyId: doc.activeHistoryState.id, width: doc.width, height: doc.height, selectionBounds: doc.selection.bounds, colorProfile: 'sRGB IEC61966-2.1' };
  }
  function inspect() { return Promise.resolve().then(() => context(app.activeDocument)); }
  async function capture(operation) {
    const doc = app.activeDocument;
    const snapshot = context(doc);
    if (operation === 'editMasked' && !snapshot.selectionBounds) throw problem('NO_SELECTION', '请先框选需要编辑的区域。');
    const pixels = await readFull(imaging, 'getPixels', doc, 4);
    let selected = null;
    if (snapshot.selectionBounds && (operation === 'editMasked' || operation === 'expand')) selected = await readFull(imaging, 'getSelection', doc, 1);
    snapshot.operation = operation;
    return {
      context: snapshot,
      image: { kind: 'rgba', width: doc.width, height: doc.height, dataBase64: toBase64(pixels) },
      mask: selected ? { kind: 'gray8', width: doc.width, height: doc.height, dataBase64: toBase64(selected) } : null,
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
      try { await imaging.putPixels({ documentID: target.id, layerID: layer.id, imageData: pixels }); }
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
    if (raw.width !== capture.context.width || raw.height !== capture.context.height)
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
