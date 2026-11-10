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
        var duplicate = null;
        try {
            duplicate = original.duplicate('PS AI capture', false);
            app.activeDocument = duplicate;
            if (context.selectionBounds && (operation === 'editMasked' || operation === 'expand'))
                PSAI.makeSelectionPng(duplicate, maskFile);
            duplicate.mergeVisibleLayers();
            PSAI.savePng(duplicate, imageFile);
            context.operation = operation;
            context.scales = options && options.scales ? options.scales : null;
            return { context: context, imagePath: imageFile.fsName, maskPath: maskFile.exists ? maskFile.fsName : null };
        } catch (error) {
            if (imageFile.exists) imageFile.remove();
            if (maskFile.exists) maskFile.remove();
            throw error;
        } finally {
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
        try {
            if (snapshot.operation === 'editMasked' || snapshot.operation === 'editWhole') {
                if (Math.round(source.width.as('px')) !== current.width || Math.round(source.height.as('px')) !== current.height)
                    PSAI.fail('RESULT_SIZE', '结果尺寸与原文档不同，结果将单独打开。');
            }
            if (snapshot.operation === 'expand' && (Math.round(source.width.as('px')) !== current.width || Math.round(source.height.as('px')) !== current.height))
                PSAI.fail('EXPANSION_REVIEW', '扩图结果尺寸与画布不同，结果将单独打开。');
            layer = source.activeLayer.duplicate(target, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = target;
            target.activeLayer = layer;
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
            }
            return { documentId: target.id, layerId: layer.id };
        } catch (error) {
            if (layer) { app.activeDocument = target; layer.remove(); }
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
