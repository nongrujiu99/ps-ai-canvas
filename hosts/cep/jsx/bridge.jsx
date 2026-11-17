#target photoshop
if (typeof JSON === 'undefined' || !JSON.stringify || !JSON.parse) {
    try { $.evalFile(File($.fileName).parent.fsName + '/json2.js'); } catch (_) {}
}

var Studio = Studio || {};

// 脚本自身的修改时间，显示在面板信息行上。
// 这轮调试最大的坑就是「改了代码但面板加载的还是旧的、服务进程也没重启」，
// 光看效果根本分不清是逻辑没修对还是代码没生效。有了这个标记就能一眼确认。
Studio.BUILD = (function () {
    try {
        var d = File($.fileName).modified;
        if (!d) return '';
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (_) { return ''; }
})();

Studio.safe = function (fn) {
    try { return JSON.stringify({ ok: true, value: fn() }); }
    catch (error) {
        var detail = '';
        try { detail = (error && error.message) ? String(error.message) : String(error); } catch (_) { detail = ''; }
        var line = (error && typeof error.line === 'number') ? (' (line ' + error.line + ')') : '';
        return JSON.stringify({ ok: false, code: error.studioCode || 'HOST_ERROR', message: (error.studioMessage || detail || 'Photoshop 操作失败，请检查当前文档。') + line });
    }
};

Studio.fail = function (code, message) {
    var error = new Error(message);
    error.studioCode = code;
    error.studioMessage = message;
    throw error;
};

// ExtendScript 的异常不一定是 Error，有时是字符串或裸对象，
// 诊断信息必须能安全地转成文本带出去（之前的 catch(_){} 就是因为怕抛错而把原因吞了）。
Studio.msg = function (error) {
    try { return (error && error.message) ? String(error.message) : String(error); } catch (_) { return 'unknown'; }
};

// 把 {left,top,right,bottom} 打成一行，用于诊断输出。
Studio.rectText = function (r) {
    if (!r) return 'null';
    if (r.left === undefined) return String(r);
    return r.left + ',' + r.top + ',' + r.right + ',' + r.bottom;
};

Studio.selectionBounds = function (doc) {
    try {
        var b = doc.selection.bounds;
        return { left: b[0].as('px'), top: b[1].as('px'), right: b[2].as('px'), bottom: b[3].as('px') };
    } catch (_) { return null; }
};

Studio.layerBounds = function (doc) {
    // 原图层在画布上的实际范围。扩图应用阶段要靠它把生成结果裁成「只留新增边缘」，
    // 这是 Photoshop 自己算出来的数，比「分析导出 PNG 的 alpha 反解比例」可靠得多：
    // 后者一旦透明区被压平成白底、或照片边缘有半透明像素，整条链路就失效，
    // 结果就是「未能裁出新增区域」、不合并、停在新图层上。
    try {
        var b = doc.activeLayer.bounds;
        var rect = { left: b[0].as('px'), top: b[1].as('px'), right: b[2].as('px'), bottom: b[3].as('px') };
        if (!(rect.right - rect.left > 0) || !(rect.bottom - rect.top > 0)) return null;
        return rect;
    } catch (_) { return null; }
};

Studio.context = function (doc) {
    var layerId = null;
    // 记下捕获时的活动图层，应用结果时要把生成内容合回这一层，
    // 而不是留一个独立的新图层（用户切换图层不会产生历史记录，所以必须靠 id 定位）。
    try { layerId = doc.activeLayer.id; } catch (_) { layerId = null; }
    return {
        documentId: doc.id,
        historyId: doc.activeHistoryState.id,
        width: Math.round(doc.width.as('px')),
        height: Math.round(doc.height.as('px')),
        colorMode: String(doc.mode),
        depth: String(doc.bitsPerChannel),
        activeLayerId: layerId,
        layerBounds: Studio.layerBounds(doc),
        selectionBounds: Studio.selectionBounds(doc)
    };
};

Studio.requireRgb8 = function (doc) {
    if (doc.mode !== DocumentMode.RGB || doc.bitsPerChannel !== BitsPerChannelType.EIGHT)
        Studio.fail('UNSUPPORTED_DOCUMENT', '首版只支持 RGB 8 位文档。');
};

Studio.inspect = function () {
    return Studio.safe(function () {
        if (!app.documents.length) Studio.fail('NO_DOCUMENT', '请先打开 Photoshop 文档。');
        var doc = app.activeDocument;
        Studio.requireRgb8(doc);
        var info = Studio.context(doc);
        info.build = Studio.BUILD;
        return info;
    });
};

Studio.savePng = function (doc, file) {
    var options = new PNGSaveOptions();
    doc.saveAs(file, options, true, Extension.LOWERCASE);
};

Studio.selectTopVisibleLayer = function (doc) {
    // mergeVisibleLayers 在「当前图层不可见」时会报「合并可见图层当前不可用」，
    // 这里先选中最上方的可见图层（或直接新建一个可见图层兜底）。
    for (var i = 0; i < doc.layers.length; i++) {
        var layer = doc.layers[i];
        if (layer.visible) { doc.activeLayer = layer; return; }
    }
    // 没有可见图层时，新增一个透明可见图层
    doc.artLayers.add();
};

Studio.workArea = function (context) {
    var full = { left: 0, top: 0, right: context.width, bottom: context.height };
    if (context.width <= 4096 && context.height <= 4096) return full;
    var b = context.selectionBounds;
    if (!b) Studio.fail('NO_SELECTION', '大图局部编辑需要先选择区域。');
    if (Math.ceil(b.right) - Math.floor(b.left) > 4096 || Math.ceil(b.bottom) - Math.floor(b.top) > 4096)
        Studio.fail('SELECTION_TOO_LARGE', '选区超过 4096 像素，请缩小选区后重试。');
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

Studio.cropToArea = function (doc, area) {
    doc.crop([UnitValue(area.left, 'px'), UnitValue(area.top, 'px'), UnitValue(area.right, 'px'), UnitValue(area.bottom, 'px')]);
};

Studio.findLayerById = function (container, id) {
    if (!container || !id) return null;
    var layers = container.layers;
    for (var i = 0; i < layers.length; i++) {
        var item = layers[i];
        try {
            if (item.id === id) return item;
            if (item.typename === 'LayerSet') {
                var found = Studio.findLayerById(item, id);
                if (found) return found;
            }
        } catch (_) { /* 个别图层属性不可读时跳过 */ }
    }
    return null;
};

// 由扩图比例反推「原照片在最终画布里的矩形」。
// 比例满足 left + right - 1 = 画布宽 / 原宽，所以原宽可直接反解出来。
Studio.innerRect = function (canvas, scales) {
    if (!scales) return null;
    var sx = Number(scales.left) + Number(scales.right) - 1;
    var sy = Number(scales.top) + Number(scales.bottom) - 1;
    if (!(sx > 0) || !(sy > 0)) return null;
    var width = canvas.width / sx;
    var height = canvas.height / sy;
    if (!(width > 0) || !(height > 0)) return null;
    var left = Math.round(width * (Number(scales.left) - 1));
    var top = Math.round(height * (Number(scales.top) - 1));
    var rect = { left: left, top: top, right: left + Math.round(width), bottom: top + Math.round(height) };
    // 合理性校验：反解结果必须落在画布内、且不小于画布的 1/4。
    // 比例要是来自滑块而不是画布透明边，算出来的矩形会离墙，宁可不动也不裁错。
    if (rect.left < 0 || rect.top < 0 || rect.right > canvas.width || rect.bottom > canvas.height) return null;
    if (rect.right - rect.left < canvas.width / 4 || rect.bottom - rect.top < canvas.height / 4) return null;
    return rect;
};

// 以前这里还有 selectRect / clearSelection / maskFromSelection 三个函数，用来「建选区→清除像素」
// 或「建选区→加图层蒙版」把结果裁成只剩新增边缘。它们在 PS CC 2018 中文版上都会报
// 「该功能不在这个版本的 Photoshop 中使用」（Dlt / Mk 两条 ActionManager 命令不可用），
// 所以整条路已废弃：现在改用 crop + duplicate 的纯 DOM 方案（见 applyExpand）。
// 两个候选范围是不是指着同一块照片。容差取画布的 2%：既要容得下半透明描边
// 和取整误差（几十像素），又不能让一整条透明带混过去。
Studio.sameRect = function (a, b, frame) {
    if (!a || !b) return false;
    var tolX = Math.max(4, frame.width * 0.02);
    var tolY = Math.max(4, frame.height * 0.02);
    return Math.abs(a.left - b.left) <= tolX && Math.abs(a.right - b.right) <= tolX
        && Math.abs(a.top - b.top) <= tolY && Math.abs(a.bottom - b.bottom) <= tolY;
};

// 由「捕获时的原图层范围」或「扩图比例」解出原照片在画布里的矩形。
// layout 分支说明画布是被 resize 出来的，原照片贴住左上角。
Studio.resolveInner = function (snapshot, frame, layout) {
    if (layout) {
        return {
            left: layout.left,
            top: layout.top,
            right: layout.left + snapshot.width,
            bottom: layout.top + snapshot.height
        };
    }
    // 比例来自画布透明边时，按比例反解出的矩形就是「画布减去透明区」，也就是原照片。
    // 而 layerBounds 只是活动图层的范围：用户把活动层停在底部那条透明带上时，它只是
    // 画面的一角。拿它当照片，整条带子会被当成新增区，结果贴到画布外面去——面板显示
    // 「已合并」、画布上却看不见。所以两个候选都在时先看它们是否一致，不一致信反解。
    var byScales = snapshot.scalesDerived ? Studio.innerRect(frame, snapshot.scales) : null;
    var lb = snapshot.layerBounds;
    if (lb) {
        var lbW = lb.right - lb.left;
        var lbH = lb.bottom - lb.top;
        // 图层铺满整张画布时它就不是「原照片」（多图层合并、或本来就没扩边），
        // 这个范围信不过，退到按比例反解。
        var coversAll = lbW >= frame.width * 0.98 && lbH >= frame.height * 0.98;
        if (!coversAll && lb.left >= 0 && lb.top >= 0 && lb.right <= frame.width && lb.bottom <= frame.height) {
            if (byScales && !Studio.sameRect(byScales, lb, frame)) return byScales;
            return { left: lb.left, top: lb.top, right: lb.right, bottom: lb.bottom };
        }
    }
    // 没有图层范围（活动层是空层/组，或 bounds 不可读）时再用比例反解。
    // 不再要求 scalesDerived 为真：innerRect 自身有「落在画布内、不小于画布 1/4」的校验。
    return byScales || Studio.innerRect(frame, snapshot.scales);
};

// 把「画布减去原照片」拆成最多 4 个矩形条带。
// 为什么要拆：整块裁掉原照片区只能靠「选区 + 清除」或「选区 + 蒙版」，而这两条命令
// 在 PS CC 2018 中文版上都会报「该功能不在这个版本的 Photoshop 中使用」。
// 逐条 crop 只用 DOM，稳定、无副作用，也不依赖选区状态。
Studio.newStrips = function (frame, inner) {
    var strips = [];
    var add = function (l, t, r, b) {
        l = Math.max(0, Math.round(l));
        t = Math.max(0, Math.round(t));
        r = Math.min(frame.width, Math.round(r));
        b = Math.min(frame.height, Math.round(b));
        if (r - l >= 1 && b - t >= 1) strips.push({ left: l, top: t, right: r, bottom: b });
    };
    // 只在「确实有扩张的那一侧」向内让 1px：比例是浮点反解出来的，取整误差会在照片
    // 边缘留一条透明缝，让 1px 出来能把接缝盖住；没扩张的边不让，避免凭空多出一条
    // 1px 的生成像素压在原图上。
    if (inner.left > 0) add(0, 0, inner.left + 1, frame.height);
    if (inner.right < frame.width) add(inner.right - 1, 0, frame.width, frame.height);
    if (inner.top > 0) add(inner.left, 0, inner.right, inner.top + 1);
    if (inner.bottom < frame.height) add(inner.left, inner.bottom - 1, inner.right, frame.height);
    return strips;
};

// 结果文档整体缩放到画布尺寸。模型输出会被量化到 16 的倍数（请求 1402 返回 1392
// 很常见），不先对齐的话，下面按条带裁切的坐标就会整体错位。
// 但「差十几个像素」和「差一截」是两回事：前者是量化误差，缩放对齐即可；后者说明
// 服务端没有按约定输出「画布尺寸 + 只有新增区有像素」的图，硬拉伸只会得到一张变形画面，
// 贴上去就是「扩展区糊成一片」。这种情况必须让调用方中断并单独打开结果。
Studio.fitSourceToFrame = function (source, frame) {
    var w = Math.round(source.width.as('px'));
    var h = Math.round(source.height.as('px'));
    if (w === frame.width && h === frame.height) return true;
    var toleranceW = Math.max(16, Math.round(frame.width * 0.02));
    var toleranceH = Math.max(16, Math.round(frame.height * 0.02));
    if (Math.abs(w - frame.width) > toleranceW || Math.abs(h - frame.height) > toleranceH)
        Studio.fail('RESULT_SIZE', '生成结果尺寸与画布对不上（' + w + '×' + h + ' / 画布 ' + frame.width + '×' + frame.height + '），结果将单独打开。');
    source.resizeImage(UnitValue(frame.width, 'px'), UnitValue(frame.height, 'px'));
    return true;
};

// 条带并集：结果图只在这块区域里有像素，对齐和校验都以它为基准。
Studio.stripUnion = function (strips) {
    var rect = null;
    for (var i = 0; i < strips.length; i++) {
        var s = strips[i];
        if (!rect) { rect = { left: s.left, top: s.top, right: s.right, bottom: s.bottom }; continue; }
        if (s.left < rect.left) rect.left = s.left;
        if (s.top < rect.top) rect.top = s.top;
        if (s.right > rect.right) rect.right = s.right;
        if (s.bottom > rect.bottom) rect.bottom = s.bottom;
    }
    return rect;
};

// 扩图结果落成**独立图层**，原图层不动。
//
// 服务端返回的结果图已经是「画布尺寸 + 只有新增区有像素」（两个供应商都在服务端
// 用 composeExpand 合成过），所以整层贴进来后，照片区 alpha=0、原图照旧透出来，
// 视觉上等价于「只贴新增区」；而原图层一个像素都不被改写。
//
// 以前为了「只贴新增区」做了「复制文档 → crop 成条带 → 复制图层 → 按绝对坐标平移 → 合并」。
// 前三步在 PS CC 2018 上都是静默杀手：crop 的边界解释随版本变、跨文档复制图层时落点
// 由 PS 自己决定（会按比例/居中放）、空图层的 bounds 也不一定为 0。任何一步错到底，
// 表现都完全一样——面板说「已合并到原图层」，画布上扩图区却整片透明，
// 也就是用户看到的「生成好了，一合并就不见了」，而且全程不报错。
// 合并这一步本身也已经去掉：不可逆、没法对比、还会破坏智能对象的可编辑性。
// 现在只保留一次图层复制：位置靠 bounds 反推，对不上就把原因带出去。
Studio.applyExpand = function (target, source, snapshot, frame, layout) {
    var out = { trimmed: false, merged: false, layer: null };
    Studio.trimReason = '';
    var inner = Studio.resolveInner(snapshot, frame, layout);
    if (!inner) {
        Studio.trimReason = 'no-inner lb=' + Studio.rectText(snapshot.layerBounds) + ' scales=' + Studio.rectText(snapshot.scales) + ' frame=' + frame.width + 'x' + frame.height;
        return out;
    }
    var strips = Studio.newStrips(frame, inner);
    if (!strips.length) {
        Studio.trimReason = 'full-canvas inner=' + Studio.rectText(inner);
        return out;
    }
    // 尺寸差太多说明这批像素不可信，让错误冒上去，由 apply 回退并让结果单独打开。
    Studio.fitSourceToFrame(source, frame);
    var union = Studio.stripUnion(strips);
    // 两条相邻边一起扩（右+下）时，新增区本身是 L 形，它的包围盒天然等于整幅画布：
    // 右边条带横跨全长、下边条带铺满全宽。这时候「bounds 等于画布」根本不是
    // 「模型画了整张画面」的证据——照旧用它判断，每次双向扩图都会误报一次
    // 「模型重写了整张画面」，而实际上图层里只有新增区有像素、照片区是透明的。
    // 只有「要扩的这块本身就接近整幅画布」时，包围盒等于画布才算证据。
    var unionCoversFrame = (union.right - union.left) >= frame.width * 0.98
        && (union.bottom - union.top) >= frame.height * 0.98;

    var layer = null;
    try {
        app.activeDocument = source;
        layer = source.activeLayer.duplicate(target, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = target;
    } catch (e) {
        Studio.trimReason = 'place ' + Studio.msg(e);
        return out;
    }

    // 对齐：读图层真实 bounds 反推「结果图的画布原点」被放到了哪里，再平移回 (0,0)。
    // 不能假设复制过来就落在 (0,0)——那正是上一版栽的跟头。
    var before = layer.bounds;
    var bx0 = Math.round(Number(before[0].as('px')));
    var by0 = Math.round(Number(before[1].as('px')));
    var bw0 = Math.round(Number(before[2].as('px'))) - bx0;
    var bh0 = Math.round(Number(before[3].as('px'))) - by0;
    var ox = bx0 - union.left;
    var oy = by0 - union.top;
    // 结果本身就是整张画面时，条带并集不能用来反推原点（并集只是画布的一部分），
    // 只能把左上角对齐到画布原点，否则会把它整块推出去。
    if (bw0 >= frame.width * 0.98 && bh0 >= frame.height * 0.98) { ox = bx0; oy = by0; }
    if (ox || oy) { try { layer.translate(UnitValue(-ox, 'px'), UnitValue(-oy, 'px')); } catch (_) { /* 锁定的图层不能平移 */ } }

    var b = layer.bounds;
    var ax = Math.round(Number(b[0].as('px')));
    var ay = Math.round(Number(b[1].as('px')));
    var aw = Math.round(Number(b[2].as('px'))) - ax;
    var ah = Math.round(Number(b[3].as('px'))) - ay;
    var aligned = Math.abs(ax - union.left) <= 2 && Math.abs(ay - union.top) <= 2 && aw >= 1 && ah >= 1;
    // 结果是「整张画面」而不是「只有新增区」时不能合并：那样会把原照片一起替换掉
    // （看起来就像整图重绘）。这种留成独立图层，用户自己决定用不用。
    // 注意这条必须先判：整张画面时 bounds 从 0 开始，天然不满足「对齐到条带起点」。
    var fullFrame = !unionCoversFrame && aw >= frame.width * 0.98 && ah >= frame.height * 0.98;
    layer.name = 'AI 图像工坊 扩图';
    if (fullFrame || !aligned) {
        Studio.trimReason = fullFrame
            ? 'full-result ' + aw + 'x' + ah
            : 'align want=' + union.left + ',' + union.top + ' got=' + ax + ',' + ay + ' size=' + aw + 'x' + ah;
        // 名字里就写清楚是哪一种：只留一层「AI 图像工坊 扩图」时，用户没法判断
        // 它是「只补了边缘」还是「把整张画面重画了一遍」——这两者该怎么用完全不同。
        layer.name = fullFrame ? 'AI 图像工坊 扩图（整张画面）' : 'AI 图像工坊 扩图（未对齐）';
        out.layer = layer;
        out.trimmed = true;
        out.separate = true;
        return out;
    }

    // 扩图结果一律留成独立图层，原图层一个像素都不动。
    //
    // 之前是合并回原图层，看着「干净」，代价却是不可逆：合并完就没法对比模型补了什么、
    // 没法单独删掉重来，原图层若是智能对象或文字层，合并还会顺手把可编辑性毁掉，
    // 而这一切都不报错。独立图层叠上去视觉完全一样（照片区是透明的，原图照旧透出来），
    // 想合并随时 Ctrl+E——这个决定应该留给用户，而不是替用户做掉。
    out.trimmed = true;
    out.merged = false;
    out.separate = true;
    out.layer = layer;
    return out;
};

Studio.capture = function (operation, options) {
    return Studio.safe(function () {
        if (!app.documents.length) Studio.fail('NO_DOCUMENT', '请先打开 Photoshop 文档。');
        var original = app.activeDocument;
        Studio.requireRgb8(original);
        var context = Studio.context(original);
        if (operation === 'editMasked' && !context.selectionBounds)
            Studio.fail('NO_SELECTION', '请先框选需要编辑的区域。');
        var folder = Folder.temp;
        var token = String(new Date().getTime()) + '-' + String(Math.floor(Math.random() * 1000000));
        var imageFile = File(folder.fsName + '/studio-image-' + token + '.png');
        var duplicate = null;
        try {
            // 遮罩绝不在这里生成。makeSelectionPng 曾用 selection.fill() 在新建的
            // 灰度文档里画黑白矩形，但 ExtendScript 的 fill 走 action manager，
            // 在部分 PS 版本（含中文 CC 2018）会作用到前台的原文档而不是临时文档，
            // 把用户框选的那块直接填黑——生成过程中画面被破坏就是这么来的。
            // 现在只抓图；遮罩由 JS 侧用 context.selectionBounds 生成（与 UXP 一致）。
            duplicate = original.duplicate('AI IMAGE STUDIO capture', false);
            app.activeDocument = duplicate;
            var area = operation === 'editMasked' ? Studio.workArea(context) : { left: 0, top: 0, right: context.width, bottom: context.height };
            context.workArea = area;
            var cropped = area.left || area.top || area.right !== context.width || area.bottom !== context.height;
            // 注意：不调用 mergeVisibleLayers()。它在「活动图层不可见」等场景会报
            // 「合并可见图层当前不可用」并弹模态框阻塞。saveAs PNG 时 PS 会自动合成
            // 所有可见图层，无需手动合并。
            if (cropped) Studio.cropToArea(duplicate, area);
            Studio.savePng(duplicate, imageFile);
            context.operation = operation;
            context.scales = options && options.scales ? options.scales : null;
            return { context: context, imagePath: imageFile.fsName, maskPath: null, applyMaskPath: null };
        } catch (error) {
            if (imageFile.exists) imageFile.remove();
            throw error;
        } finally {
            if (duplicate) duplicate.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = original;
        }
    });
};

Studio.revealSelectionMask = function () {
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

// 模型会把输出尺寸量化到 16 的倍数（请求 1402 宽、实际返回 1392 是常态），
// 所以不能要求像素级一致：左上方向按比例取整，取整误差全部塞给右/下。
Studio.expandLayoutTolerant = function (snapshot, resultWidth, resultHeight) {
    var scales = snapshot.scales;
    if (!scales) return null;
    var left = Math.round(snapshot.width * (Number(scales.left) - 1));
    var top = Math.round(snapshot.height * (Number(scales.top) - 1));
    if (left < 0 || top < 0) return null;
    var right = resultWidth - snapshot.width - left;
    var bottom = resultHeight - snapshot.height - top;
    if (right < 0 || bottom < 0) return null;
    return { left: left, right: right, top: top, bottom: bottom };
};

// 把图层整体缩放到指定尺寸，并把左上角对齐到画布原点。
// 模型输出和画布差几像素时靠这个贴合，而不是放弃应用、另开一个文档。
Studio.scaleLayerToFrame = function (layer, targetWidth, targetHeight) {
    var b = layer.bounds;
    var curWidth = b[2].as('px') - b[0].as('px');
    var curHeight = b[3].as('px') - b[1].as('px');
    if (!(curWidth > 0) || !(curHeight > 0)) return false;
    var pctWidth = targetWidth / curWidth * 100;
    var pctHeight = targetHeight / curHeight * 100;
    if (Math.abs(pctWidth - 100) < 0.01 && Math.abs(pctHeight - 100) < 0.01) return true;
    var scaled = false;
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
        desc.putReference(charIDToTypeID('null'), ref);
        var transform = new ActionDescriptor();
        transform.putUnitDouble(charIDToTypeID('Wdth'), charIDToTypeID('#Prc'), pctWidth);
        transform.putUnitDouble(charIDToTypeID('Hght'), charIDToTypeID('#Prc'), pctHeight);
        desc.putObject(charIDToTypeID('T   '), charIDToTypeID('Trnf'), transform);
        executeAction(charIDToTypeID('Trnf'), desc, DialogModes.NO);
        scaled = true;
    } catch (_) {
        scaled = false;
    }
    if (!scaled) {
        // 兜底：等比缩放，锚点固定在左上角，避免尺寸之外再叠一层位移误差
        layer.resize(Math.min(pctWidth, pctHeight), AnchorPosition.TOPLEFT);
    }
    var after = layer.bounds;
    var dx = -after[0].as('px');
    var dy = -after[1].as('px');
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) layer.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
    return true;
};

Studio.apply = function (resultPath, snapshot, maskPath) {
    return Studio.safe(function () {
        if (!app.documents.length) Studio.fail('STALE_DOCUMENT', '原文档已关闭，结果将单独打开。');
        var target = app.activeDocument;
        var current = Studio.context(target);
        // 只比较「文档身份 + 画布尺寸」。历史记录 id 不能用：光是取消选区、
        // 切图层都会新增一条历史，拿它做校验会让等待期间的一切操作都变成「文档已变」，
        // 结果被迫另开新文档——这正是之前反复「跳到新画布」的原因之一。
        if (current.documentId !== snapshot.documentId || current.width !== snapshot.width || current.height !== snapshot.height)
            Studio.fail('STALE_DOCUMENT', '文档在等待期间被关闭或改变了尺寸，结果将单独打开。');
        var resultFile = File(resultPath);
        if (!resultFile.exists) Studio.fail('RESULT_MISSING', '生成结果文件不存在。');
        // 必须赶在 app.open 之前记录历史状态：打开结果文档后它就变成了前台文档，
        // 此时再读原文档的 activeHistoryState，Photoshop 会报
        // 「请求的动作要求目标文档是最前面的文档」，整个应用流程直接中断。
        var priorHistory = null;
        try { priorHistory = target.activeHistoryState; } catch (_) { priorHistory = null; }
        var source = null;
        var layer = null;
        var merged = false;
        var trimmed = false;
        var separate = false;
        var resized = false;
        // 诊断字段是全局的，每次应用前清一次，避免把上一次的失败原因带出来误导排查。
        Studio.trimReason = '';
        try {
            source = app.open(resultFile);
            // 同样要先取好：后面可能把前台切回原文档，届时再读 source.activeLayer 会报同一个错。
            var sourceLayer = source.activeLayer;
            if (snapshot.operation === 'editMasked' || snapshot.operation === 'editWhole') {
                var area = snapshot.workArea || { left: 0, top: 0, right: current.width, bottom: current.height };
                if (Math.round(source.width.as('px')) !== area.right - area.left || Math.round(source.height.as('px')) !== area.bottom - area.top)
                    Studio.fail('RESULT_SIZE', '结果尺寸与原文档不同，结果将单独打开。');
            }
            var resultWidth = Math.round(source.width.as('px'));
            var resultHeight = Math.round(source.height.as('px'));
            var isExpand = snapshot.operation === 'expand';
            var fitsCanvas = Math.abs(resultWidth - current.width) <= 16 && Math.abs(resultHeight - current.height) <= 16;
            // 画布本身就是最终画框：比例来自画布透明边（画布已经扩好），
            // 或者模型输出尺寸和画布基本一致。这两种情况都绝不能去动画布大小。
            var canvasIsFrame = isExpand && (!!snapshot.scalesDerived || fitsCanvas);
            var layout = null;
            if (isExpand && !canvasIsFrame) {
                layout = Studio.expandLayoutTolerant(snapshot, resultWidth, resultHeight);
                if (!layout) Studio.fail('EXPANSION_REVIEW', '模型返回的尺寸和扩图比例对不上，结果将单独打开。');
                app.activeDocument = target;
                if (layout.left || layout.top) { target.resizeCanvas(UnitValue(current.width + layout.left, 'px'), UnitValue(current.height + layout.top, 'px'), AnchorPosition.BOTTOMRIGHT); resized = true; }
                if (layout.right || layout.bottom) { target.resizeCanvas(UnitValue(resultWidth, 'px'), UnitValue(resultHeight, 'px'), AnchorPosition.TOPLEFT); resized = true; }
            }
            if (isExpand) {
                // 扩图不复制整层去覆盖：整层是「原图 + 重画过的背景」的完整重绘结果，
                // 直接盖上去会把原照片和背景一起替换掉（看起来就像「整图重绘」）。
                // applyExpand 只把新扩出来的边缘贴成独立图层，原图层保持原样。
                var frame = layout ? { width: resultWidth, height: resultHeight } : { width: current.width, height: current.height };
                var done = Studio.applyExpand(target, source, snapshot, frame, layout);
                trimmed = done.trimmed;
                merged = done.merged;
                separate = done.separate === true;
                layer = done.layer;
            } else {
                layer = sourceLayer.duplicate(target, ElementPlacement.PLACEATBEGINNING);
                app.activeDocument = target;
                target.activeLayer = layer;
                if (snapshot.operation === 'editMasked' && snapshot.workArea) {
                    // 这里以前直接按 workArea 绝对坐标平移，隐含假设「复制到新文档就落在 (0,0)」。
                    // 同一个文件里 applyExpand 已经因为这个假设栽过一次：PS 把图层搬进
                    // 尺寸不同的文档时落点由它自己决定（实测会按比例/居中放置），
                    // 再叠一层绝对坐标平移就会整块偏出画布——而且全程不报错。
                    // 大画布的局部编辑（workArea 不在原点）会直接踩到。改成读真实 bounds 反推偏移。
                    var placed = layer.bounds;
                    var placedX = Math.round(Number(placed[0].as('px')));
                    var placedY = Math.round(Number(placed[1].as('px')));
                    var shiftX = snapshot.workArea.left - placedX;
                    var shiftY = snapshot.workArea.top - placedY;
                    if (shiftX || shiftY) layer.translate(UnitValue(shiftX, 'px'), UnitValue(shiftY, 'px'));
                    var norm = layer.bounds;
                    var normX = Math.round(Number(norm[0].as('px')));
                    var normY = Math.round(Number(norm[1].as('px')));
                    if (Math.abs(normX - snapshot.workArea.left) > 2 || Math.abs(normY - snapshot.workArea.top) > 2)
                        Studio.fail('RESULT_SIZE', '结果无法对齐到原选区位置（期望 ' + snapshot.workArea.left + ',' + snapshot.workArea.top + '，实际 ' + normX + ',' + normY + '），结果将单独打开。');
                }
                layer.name = snapshot.operation === 'editWhole' ? 'AI 图像工坊 整图重绘'
                    : snapshot.operation === 'generate' ? 'AI 图像工坊 生成' : 'AI 图像工坊 选区编辑';
                if (snapshot.operation === 'editMasked') {
                    // 用抓图时读到的选区坐标重建选区，不再从遮罩文件加载。
                    // 遮罩文件已彻底移除：以前把它存成灰度 PNG 再 app.open 读回，
                    // 除了会污染原图，还在部分版本上因通道读取失败而报错。
                    // selectionBounds 是 capture 时从 doc.selection.bounds 只读拿到的，
                    // 坐标就是原文档坐标，直接 select 即可，全程不碰像素。
                    var b = snapshot.selectionBounds;
                    if (!b) Studio.fail('NO_SELECTION', '原选区已丢失，无法应用结果。');
                    var region = [
                        [UnitValue(b.left, 'px'), UnitValue(b.top, 'px')],
                        [UnitValue(b.right, 'px'), UnitValue(b.top, 'px')],
                        [UnitValue(b.right, 'px'), UnitValue(b.bottom, 'px')],
                        [UnitValue(b.left, 'px'), UnitValue(b.bottom, 'px')]
                    ];
                    target.selection.select(region, SelectionType.REPLACE, 0, false);
                    // 建图层蒙版（Mk '）在部分版本上会报「该功能不在这个版本的 Photoshop
                    // 中使用」。失败时保留整层并把原因带回面板，不要把已经贴好的结果整段回滚。
                    try { Studio.revealSelectionMask(); } catch (e) { Studio.trimReason = 'mask=' + Studio.msg(e); }
                }
            }
            return { documentId: target.id, layerId: layer ? layer.id : null, merged: merged, separate: separate, trimmed: trimmed, trimReason: Studio.trimReason || '', operation: snapshot.operation || null, layerName: layer ? layer.name : '' };
        } catch (error) {
            app.activeDocument = target;
            // 扩图可能已经 resize 过画布或并进了部分条带，失败了要整段回退，
            // 否则会在文档里留下「半张扩图」这种更难收拾的状态。
            // 但只在**真的动过文档**时回退：resized 改过画布、trimmed/merged 已经贴进条带。
            // 不能按「只要是扩图就回退」处理——那会把用户在等待期间做的操作（切图层、
            // 改画布、画别的东西）一起撤销，代价比这次失败本身还大。
            if ((resized || trimmed || merged) && priorHistory) {
                try { target.activeHistoryState = priorHistory; }
                catch (_) { Studio.fail('ROLLBACK_FAILED', '扩图回退失败，请检查当前文档的历史记录。'); }
            } else if (layer) {
                try { layer.remove(); } catch (_) { /* 已被合并时移除会失败，忽略 */ }
            }
            throw error;
        } finally {
            // 无论成功失败都要关掉临时打开的结果文档并把焦点还给原文档，
            // 否则出错时那张结果图会一直留在界面上，看起来就像「新建了画布」。
            if (source && source !== target) { try { source.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {} }
            app.activeDocument = target;
        }
    });
};

Studio.openSeparate = function (resultPath) {
    return Studio.safe(function () {
        var file = File(resultPath);
        if (!file.exists) Studio.fail('RESULT_MISSING', '生成结果文件不存在。');
        var doc = app.open(file);
        return { documentId: doc.id };
    });
};
