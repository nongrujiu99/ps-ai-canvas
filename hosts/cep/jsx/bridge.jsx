#target photoshop
#include "json2.js"

var PSAI = PSAI || {};

PSAI.safe = function (fn) {
    try { return JSON.stringify({ ok: true, value: fn() }); }
    catch (error) {
        return JSON.stringify({ ok: false, code: error.psaiCode || 'HOST_ERROR', message: error.psaiMessage || 'Photoshop 操作失败，请检查当前文档。' });
    }
};

PSAI.fail = function (code, message) {
    var error = new Error(message);
    error.psaiCode = code;
    error.psaiMessage = message;
    throw error;
};

PSAI.selectionBounds = function (doc) {
    try {
        var b = doc.selection.bounds;
        return { left: b[0].as('px'), top: b[1].as('px'), right: b[2].as('px'), bottom: b[3].as('px') };
    } catch (_) { return null; }
};

PSAI.context = function (doc) {
    return {
        documentId: doc.id,
        historyId: doc.activeHistoryState.id,
        width: Math.round(doc.width.as('px')),
        height: Math.round(doc.height.as('px')),
        colorMode: String(doc.mode),
        depth: String(doc.bitsPerChannel),
        selectionBounds: PSAI.selectionBounds(doc)
    };
};

PSAI.requireRgb8 = function (doc) {
    if (doc.mode !== DocumentMode.RGB || doc.bitsPerChannel !== BitsPerChannelType.EIGHT)
        PSAI.fail('UNSUPPORTED_DOCUMENT', '首版只支持 RGB 8 位文档。');
};

PSAI.inspect = function () {
    return PSAI.safe(function () {
        if (!app.documents.length) PSAI.fail('NO_DOCUMENT', '请先打开 Photoshop 文档。');
        var doc = app.activeDocument;
        PSAI.requireRgb8(doc);
        return PSAI.context(doc);
    });
};

PSAI.savePng = function (doc, file) {
    var options = new PNGSaveOptions();
    doc.saveAs(file, options, true, Extension.LOWERCASE);
};

PSAI.makeSelectionPng = function (source, file) {
    var channel = source.channels.add();
    channel.name = 'PS AI temporary selection';
    source.selection.store(channel, SelectionType.REPLACE);
    var maskDoc = null;
    try {
        maskDoc = app.documents.add(source.width, source.height, source.resolution, 'PS AI mask', NewDocumentMode.GRAYSCALE, DocumentFill.BLACK);
        app.activeDocument = maskDoc;
        maskDoc.selection.load(channel, SelectionType.REPLACE);
        var white = new SolidColor();
        white.gray.gray = 100;
        maskDoc.selection.fill(white);
        maskDoc.selection.deselect();
        PSAI.savePng(maskDoc, file);
    } finally {
        if (maskDoc) maskDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = source;
        channel.remove();
    }
};

PSAI.workArea = function (context) {
    var full = { left: 0, top: 0, right: context.width, bottom: context.height };
    if (context.width <= 4096 && context.height <= 4096) return full;
    var b = context.selectionBounds;
    if (!b) PSAI.fail('NO_SELECTION', '大图局部编辑需要先选择区域。');
    if (Math.ceil(b.right) - Math.floor(b.left) > 4096 || Math.ceil(b.bottom) - Math.floor(b.top) > 4096)
        PSAI.fail('SELECTION_TOO_LARGE', '选区超过 4096 像素，请缩小选区后重试。');
    function axis(length, start, end) {
        var size = Math.min(length, 4096, Math.max(512, Math.ceil(end) - Math.floor(start) + 512));
        var center = (start + end) / 2;
        var left = Math.max(0, Math.min(length - size, Math.floor(center - size / 2)));
        return [left, left + size];
    }
    var x = axis(context.width, b.left, b.right);
    var y = axis(context.height, b.top, b.bottom);
    return { left: x[0], top: y[0], right: x[1], bottom: y[1] };
};

PSAI.cropToArea = function (doc, area) {
    doc.crop([UnitValue(area.left, 'px'), UnitValue(area.top, 'px'), UnitValue(area.right, 'px'), UnitValue(area.bottom, 'px')]);
};

PSAI.capture = function (operation, options) {
    return PSAI.safe(function () {
        if (!app.documents.length) PSAI.fail('NO_DOCUMENT', '请先打开 Photoshop 文档。');
        var original = app.activeDocument;
        PSAI.requireRgb8(original);
        var context = PSAI.context(original);
        if (operation === 'editMasked' && !context.selectionBounds)
            PSAI.fail('NO_SELECTION', '请先框选需要编辑的区域。');
        var folder = Folder.temp;
        var token = String(new Date().getTime()) + '-' + String(Math.floor(Math.random() * 1000000));
        var imageFile = File(folder.fsName + '/ps-ai-image-' + token + '.png');
        var maskFile = File(folder.fsName + '/ps-ai-mask-' + token + '.png');
        var workMaskFile = File(folder.fsName + '/ps-ai-work-mask-' + token + '.png');
        var duplicate = null;
        var workMaskDoc = null;
        try {
            duplicate = original.duplicate('PS AI capture', false);
            app.activeDocument = duplicate;
            if (context.selectionBounds && (operation === 'editMasked' || operation === 'expand'))
                PSAI.makeSelectionPng(duplicate, maskFile);
            var area = operation === 'editMasked' ? PSAI.workArea(context) : { left: 0, top: 0, right: context.width, bottom: context.height };
            context.workArea = area;
            var cropped = area.left || area.top || area.right !== context.width || area.bottom !== context.height;
            if (cropped && maskFile.exists) {
                workMaskDoc = app.open(maskFile);
                PSAI.cropToArea(workMaskDoc, area);
                PSAI.savePng(workMaskDoc, workMaskFile);
                workMaskDoc.close(SaveOptions.DONOTSAVECHANGES);
                workMaskDoc = null;
                app.activeDocument = duplicate;
            }
            duplicate.mergeVisibleLayers();
            if (cropped) PSAI.cropToArea(duplicate, area);
            PSAI.savePng(duplicate, imageFile);
            context.operation = operation;
            context.scales = options && options.scales ? options.scales : null;
            return { context: context, imagePath: imageFile.fsName, maskPath: cropped ? workMaskFile.fsName : maskFile.exists ? maskFile.fsName : null, applyMaskPath: maskFile.exists ? maskFile.fsName : null };
        } catch (error) {
            if (imageFile.exists) imageFile.remove();
            if (maskFile.exists) maskFile.remove();
            if (workMaskFile.exists) workMaskFile.remove();
            throw error;
        } finally {
            if (workMaskDoc) workMaskDoc.close(SaveOptions.DONOTSAVECHANGES);
            if (duplicate) duplicate.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = original;
        }
    });
};

PSAI.revealSelectionMask = function () {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putClass(charIDToTypeID('Chnl'));
    desc.putReference(charIDToTypeID('Nw  '), ref);
    var target = new ActionReference();
    target.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('Msk '));
    desc.putReference(charIDToTypeID('At  '), target);
    desc.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('UsrM'), charIDToTypeID('RvlS'));
    executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
};

PSAI.expandLayout = function (snapshot, resultWidth, resultHeight) {
    var scales = snapshot.scales;
    if (!scales) PSAI.fail('EXPANSION_REVIEW', '缺少扩图比例，结果将单独打开。');
    var left = Math.round(snapshot.width * (scales.left - 1));
    var right = Math.round(snapshot.width * (scales.right - 1));
    var top = Math.round(snapshot.height * (scales.top - 1));
    var bottom = Math.round(snapshot.height * (scales.bottom - 1));
    if (left < 0 || right < 0 || top < 0 || bottom < 0 || resultWidth !== snapshot.width + left + right || resultHeight !== snapshot.height + top + bottom)
        PSAI.fail('EXPANSION_REVIEW', '模型输出尺寸与扩图比例不一致，结果将单独打开。');
    return { left: left, right: right, top: top, bottom: bottom };
};

PSAI.apply = function (resultPath, snapshot, maskPath) {
    return PSAI.safe(function () {
        if (!app.documents.length) PSAI.fail('STALE_DOCUMENT', '原文档已关闭，结果将单独打开。');
        var target = app.activeDocument;
        var current = PSAI.context(target);
        if (current.documentId !== snapshot.documentId || current.width !== snapshot.width || current.height !== snapshot.height || current.historyId !== snapshot.historyId)
            PSAI.fail('STALE_DOCUMENT', '文档在等待期间发生变化，结果将单独打开。');
        var resultFile = File(resultPath);
        if (!resultFile.exists) PSAI.fail('RESULT_MISSING', '生成结果文件不存在。');
        var source = app.open(resultFile);
        var layer = null;
        var selectionDoc = null;
        var priorHistory = target.activeHistoryState;
        var resized = false;
        try {
            if (snapshot.operation === 'editMasked' || snapshot.operation === 'editWhole') {
                var area = snapshot.workArea || { left: 0, top: 0, right: current.width, bottom: current.height };
                if (Math.round(source.width.as('px')) !== area.right - area.left || Math.round(source.height.as('px')) !== area.bottom - area.top)
                    PSAI.fail('RESULT_SIZE', '结果尺寸与原文档不同，结果将单独打开。');
            }
            var resultWidth = Math.round(source.width.as('px'));
            var resultHeight = Math.round(source.height.as('px'));
            var sliderExpansion = snapshot.operation === 'expand' && !maskPath && (resultWidth !== current.width || resultHeight !== current.height);
            var layout = sliderExpansion ? PSAI.expandLayout(snapshot, resultWidth, resultHeight) : null;
            if (snapshot.operation === 'expand' && !sliderExpansion && (resultWidth !== current.width || resultHeight !== current.height))
                PSAI.fail('EXPANSION_REVIEW', '扩图结果尺寸与画布不同，结果将单独打开。');
            if (sliderExpansion) {
                app.activeDocument = target;
                if (layout.left || layout.top) { target.resizeCanvas(UnitValue(current.width + layout.left, 'px'), UnitValue(current.height + layout.top, 'px'), AnchorPosition.BOTTOMRIGHT); resized = true; }
                if (layout.right || layout.bottom) { target.resizeCanvas(UnitValue(resultWidth, 'px'), UnitValue(resultHeight, 'px'), AnchorPosition.TOPLEFT); resized = true; }
            }
            layer = source.activeLayer.duplicate(target, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = target;
            target.activeLayer = layer;
            if (snapshot.operation === 'editMasked' && snapshot.workArea && (snapshot.workArea.left || snapshot.workArea.top))
                layer.translate(UnitValue(snapshot.workArea.left, 'px'), UnitValue(snapshot.workArea.top, 'px'));
            layer.name = snapshot.operation === 'expand' ? 'PS AI 扩图' : snapshot.operation === 'editWhole' ? 'PS AI 整图重绘' : 'PS AI 选区编辑';
            if (snapshot.operation === 'editMasked' || (snapshot.operation === 'expand' && maskPath)) {
                var selectionFile = File(maskPath);
                if (!selectionFile.exists) PSAI.fail('RESULT_MISSING', '选区蒙版文件不存在。');
                selectionDoc = app.open(selectionFile);
                if (Math.round(selectionDoc.width.as('px')) !== current.width || Math.round(selectionDoc.height.as('px')) !== current.height)
                    PSAI.fail('RESULT_SIZE', '选区蒙版尺寸与画布不同。');
                app.activeDocument = target;
                target.selection.load(selectionDoc.channels[0], SelectionType.REPLACE);
                PSAI.revealSelectionMask();
            } else if (sliderExpansion) {
                target.selection.select([
                    [UnitValue(layout.left, 'px'), UnitValue(layout.top, 'px')],
                    [UnitValue(layout.left + current.width, 'px'), UnitValue(layout.top, 'px')],
                    [UnitValue(layout.left + current.width, 'px'), UnitValue(layout.top + current.height, 'px')],
                    [UnitValue(layout.left, 'px'), UnitValue(layout.top + current.height, 'px')]
                ], SelectionType.REPLACE, 0, false);
                target.selection.invert();
                PSAI.revealSelectionMask();
                target.selection.deselect();
            }
            return { documentId: target.id, layerId: layer.id };
        } catch (error) {
            app.activeDocument = target;
            if (resized) {
                try { target.activeHistoryState = priorHistory; }
                catch (_) { PSAI.fail('ROLLBACK_FAILED', '扩图回退失败，请检查当前文档的历史记录。'); }
            } else if (layer) layer.remove();
            throw error;
        } finally {
            if (selectionDoc) selectionDoc.close(SaveOptions.DONOTSAVECHANGES);
            source.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = target;
        }
    });
};

PSAI.openSeparate = function (resultPath) {
    return PSAI.safe(function () {
        var file = File(resultPath);
        if (!file.exists) PSAI.fail('RESULT_MISSING', '生成结果文件不存在。');
        var doc = app.open(file);
        return { documentId: doc.id };
    });
};
