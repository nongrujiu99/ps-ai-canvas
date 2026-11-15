'use strict';

const sharp = require('sharp');
const { problem } = require('./contract');

// Photoshop 抓取的高分辨率照片 PNG 很容易超过 10 MB（2048×2560 写实照片常在
// 12~25 MB）。本地上限只用于防止异常巨大数据撑爆内存，真正的上传体积由
// providers/aliyun.js 里的压缩逻辑控制。
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

// 本地服务是单线程 HTTP：一张 8192² 的图逐像素扫一遍是 6700 万次迭代，
// 整段同步跑完期间连 /health 都不响应，面板的轮询请求会全排在后面，
// 界面看起来就是「服务卡死了」。每扫若干行主动让一次事件循环，
// 代价只有几十次 setTimeout，换来的是扫描期间服务仍然可用。
const YIELD_ROWS = 256;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// 4 通道 RGBA 的 alpha 扫描 + 不透明/透明包围盒统计。
async function scanAlpha(pixels, width, height) {
  let left = width, top = height, right = 0, bottom = 0;
  let tLeft = width, tTop = height, tRight = 0, tBottom = 0;
  let transparentCount = 0;
  for (let y = 0; y < height; y++) {
    if (y > 0 && y % YIELD_ROWS === 0) await yieldToLoop();
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const alpha = pixels[row + x * 4 + 3];
      if (alpha === 0) {
        transparentCount++;
        if (x < tLeft) tLeft = x;
        if (x + 1 > tRight) tRight = x + 1;
        // 透明区按行累加，只需在首末行更新上下边界
        if (y < tTop) tTop = y;
        if (y + 1 > tBottom) tBottom = y + 1;
      } else {
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
    }
  }
  return { left, top, right, bottom, tLeft, tTop, tRight, tBottom, transparentCount };
}

// 「规则透明」= 照片区不透明、其余透明，但允许照片边界留一圈过渡带。
// 原来的判定要求每个像素严格等于 255 或 0，只要照片边缘有抗锯齿、描边或柔和投影，
// 就会被判成「不规则透明」——用户会在扩图时收到「请先整理画布」这种毫无线索的报错，
// 而他其实什么都没做错。过渡带以外的杂散半透明仍然判不规则（那才是真的要整理）。
async function scanRegular(pixels, width, height, box) {
  const edge = 2;
  for (let y = 0; y < height; y++) {
    if (y > 0 && y % YIELD_ROWS === 0) await yieldToLoop();
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const alpha = pixels[row + x * 4 + 3];
      const inside = x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      if (alpha === (inside ? 255 : 0)) continue;
      const nearEdge = x >= box.left - edge && x < box.right + edge && y >= box.top - edge && y < box.bottom + edge
        && (x < box.left + edge || x >= box.right - edge || y < box.top + edge || y >= box.bottom - edge);
      if (!nearEdge) return false;
    }
  }
  return true;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw problem('INVALID_IMAGE_DATA', '图像编码无效。');
  }
  return Buffer.from(value, 'base64');
}

async function decodeOne(source, expectedKind) {
  if (!source || typeof source !== 'object') throw problem('INVALID_IMAGE_DATA', '缺少图像数据。');
  if (source.kind === 'encoded') {
    const raw = String(source.dataUrl || '').replace(/\s+/g, '');
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
    if (!match) throw problem('INVALID_IMAGE_DATA', '仅支持 PNG 或 JPEG 图像。');
    return decodeBase64(match[2]);
  }
  const components = expectedKind === 'image' ? 4 : 1;
  const kind = expectedKind === 'image' ? 'rgba' : 'gray8';
  if (source.kind !== kind || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1) {
    throw problem('INVALID_IMAGE_DATA', '原始像素参数无效。');
  }
  const bytes = decodeBase64(source.dataBase64);
  if (bytes.length !== source.width * source.height * components) {
    throw problem('INVALID_IMAGE_DATA', '原始像素长度与尺寸不符。');
  }
  return sharp(bytes, { raw: { width: source.width, height: source.height, channels: components } }).png().toBuffer();
}

async function decodeCapture(image, mask) {
  const pngBytes = await decodeOne(image, 'image');
  const maskBytes = mask ? await decodeOne(mask, 'mask') : undefined;
  return { pngBytes, maskBytes };
}

async function inspectImage(pngBytes, maskBytes) {
  if (!Buffer.isBuffer(pngBytes) || pngBytes.length > MAX_IMAGE_BYTES) {
    throw problem('IMAGE_TOO_LARGE', '图像文件超过 40 MB。');
  }
  const meta = await sharp(pngBytes).metadata();
  const { width, height } = meta;
  // 上限从 4096 提到 8192：扩图时「先把画布拉大」是标准用法，照片本身 4000 多像素
  // 宽很常见（4200×2560 的画布以前会被一句「宽高需在 512 到 4096」直接拒掉，
  // 用户完全看不懂）。后续无论送模型还是合成都会缩放到模型能吃的尺寸，
  // 这里只需要挡住真正会撑爆内存的巨图。
  if (width < 512 || width > 8192 || height < 512 || height > 8192) {
    throw problem('IMAGE_DIMENSIONS', '图像宽高需在 512 到 8192 像素之间。');
  }
  if (meta.depth && meta.depth !== 'uchar') {
    throw problem('IMAGE_DEPTH', '仅支持 8 位图像。');
  }
  if (meta.space && !['srgb', 'rgb'].includes(meta.space)) {
    throw problem('IMAGE_COLOR_MODE', '仅支持 RGB 图像。');
  }

  const pixels = await sharp(pngBytes).ensureAlpha().raw().toBuffer();
  const scan = await scanAlpha(pixels, width, height);
  if (scan.right === 0 || scan.bottom === 0) throw problem('NO_OPAQUE_REGION', '找不到不透明原图区域。');
  const opaqueBounds = { left: scan.left, top: scan.top, right: scan.right, bottom: scan.bottom };
  const transparentBounds = scan.transparentCount > 0
    ? { left: scan.tLeft, top: scan.tTop, right: scan.tRight, bottom: scan.tBottom }
    : null;
  // 透明像素一个都没有时不必再扫第二遍。
  const regular = scan.transparentCount === 0 ? true : await scanRegular(pixels, width, height, opaqueBounds);

  let selectionKind = 'none';
  let selectionBounds = null;
  if (maskBytes) {
    const maskMeta = await sharp(maskBytes).metadata();
    if (maskMeta.width !== width || maskMeta.height !== height) {
      throw problem('MASK_DIMENSIONS', '选区遮罩尺寸与图像不一致。');
    }
    const selected = await sharp(maskBytes).removeAlpha().greyscale().raw().toBuffer();
    let selectedOpaque = 0, selectedTransparent = 0;
    let sLeft = width, sTop = height, sRight = 0, sBottom = 0;
    for (let y = 0; y < height; y++) {
      if (y > 0 && y % YIELD_ROWS === 0) await yieldToLoop();
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        // 用 128 阈值而非 >0：Photoshop 选框默认抗锯齿，边界会留下半透明灰边，
        // 若按 >0 计数，稍贴边的选区就会被误判成「压住了照片」。
        if (selected[index] < 128) continue;
        if (x < sLeft) sLeft = x;
        if (x + 1 > sRight) sRight = x + 1;
        if (y < sTop) sTop = y;
        if (y + 1 > sBottom) sBottom = y + 1;
        if (pixels[index * 4 + 3] === 255) selectedOpaque++;
        else selectedTransparent++;
      }
    }
    if (sRight > sLeft && sBottom > sTop) selectionBounds = { left: sLeft, top: sTop, right: sRight, bottom: sBottom };
    if (selectedOpaque || selectedTransparent) {
      if (selectedOpaque && selectedTransparent) {
        // 选区同时跨越照片与透明区 → 不明确
        selectionKind = 'ambiguous';
      } else if (selectedOpaque) {
        // 选区完全在照片内部 → 局部编辑
        selectionKind = 'inside';
      } else if (regular) {
        // 选区完全落在透明区（只框了棋盘格）且照片透明规则 → 扩图
        selectionKind = 'transparentBorder';
      } else {
        // 选区落在透明区但照片有不规则透明（如内部洞）→ 不明确
        selectionKind = 'ambiguous';
      }
    }
  }

  return { width, height, opaqueBounds, transparentBounds, selectionBounds, selectionKind, regularTransparency: regular };
}

// inspection 可以传入：/v1/inspect 已经算过一遍了，再算一次等于把同一张图
// 逐像素扫两次（大图上是秒级的浪费），所以允许调用方把结果带进来复用。
async function prepareExpansion(pngBytes, maskBytes, inspection) {
  const info = inspection || await inspectImage(pngBytes, maskBytes);
  if (info.selectionKind !== 'transparentBorder') {
    throw problem('NOT_EXPANSION_SELECTION', '选区不是规则透明边缘。');
  }
  const { left, top, right, bottom } = info.opaqueBounds;
  const originalWidth = right - left;
  const originalHeight = bottom - top;
  const scales = {
    topScale: 1 + top / originalHeight,
    rightScale: 1 + (info.width - right) / originalWidth,
    bottomScale: 1 + (info.height - bottom) / originalHeight,
    leftScale: 1 + left / originalWidth,
  };
  if (Object.values(scales).some((scale) => scale > 2)) {
    throw problem('INVALID_SCALE', '透明边缘超出模型单次扩图范围。');
  }
  const originalPng = await sharp(pngBytes).extract({ left, top, width: originalWidth, height: originalHeight }).png().toBuffer();
  return { originalPng, ...scales };
}

// 指令式图像编辑模型（wan2.7 / qwen-image-2.0 等）没有 scales 参数，只接受
// 「一张图 + 一句指令 + 指定输出尺寸」。所以扩图不能再说「往右扩 1.234 倍」，
// 而要先把照片铺满目标画布：延伸区变成颜色和光影连续、但没有具体内容的色带，
// 模型只需把色带重绘成真实细节。
//
// 底稿怎么铺，直接决定模型画出来像不像同一张照片。两种错法都踩过：
//
// ① 整张镜像 → 人物、手、平板被原样复制到延伸区，「左右重复」。
// ② 边缘窄条循环复制（曾经的做法）→ 更隐蔽：窄条里本来就含着笔筒、书堆、
//    桌沿这些物体碎片，循环一次就相当于在延伸区盖一枚印章。模型看到四五份
//    重复的杯子，自然就照着画出一个杯子和一堆书——用户看到的就是
//    「右边突然多出东西、内容接不上」。底稿阶段就已经错了，后面怎么调提示词
//    都救不回来。
//
// 现在改成「沿趋势外推」：只看边界那一条的走向，把它按衰减斜率延伸出去。
// 水平的桌沿、墙裙线会继续水平走；竖直的墙角、边缘会继续竖直走；而物体
// （杯子、书、手）不会被复制——它们只贡献一条边缘色，不会贡献形状。
// 模型拿到的是一张「结构对得上、内容留白」的底稿，这是它画得对的前提。
const EXTRAP_BAND_MAX = 96;
const EXTRAP_SLOPE_MAX = 1.5; // 每像素最多 ±1.5 灰阶，防止把噪声放大成斜坡

// at(i)：i=0 是紧贴边界那一像素，i 越大越往画面里。
// 返回边界色与「朝外」的每像素变化量：往里越走越亮，说明外面应该更亮。
function edgeTrend(at, count, band) {
  const edge = at(0);
  if (!edge) return null;
  const slope = [0, 0, 0];
  if (band >= 2 && count >= band * 2 + 2) {
    const near = [0, 0, 0];
    const far = [0, 0, 0];
    for (let k = 1; k <= band; k++) {
      const a = at(k);
      const b = at(band + k);
      if (!a || !b) continue;
      for (let c = 0; c < 3; c++) { near[c] += a[c]; far[c] += b[c]; }
    }
    for (let c = 0; c < 3; c++) {
      const v = (near[c] - far[c]) / band / band;
      slope[c] = v > EXTRAP_SLOPE_MAX ? EXTRAP_SLOPE_MAX : v < -EXTRAP_SLOPE_MAX ? -EXTRAP_SLOPE_MAX : v;
    }
  }
  return { edge: [edge[0], edge[1], edge[2]], slope };
}

// 距离 d 处的颜色：斜率按 band 宽度饱和（exp 衰减），走远之后不再线性发散。
function extrudeColor(profile, d, band) {
  const reach = band * (1 - Math.exp(-d / Math.max(1, band * 0.7)));
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = profile.edge[c] + profile.slope[c] * reach;
    out[c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

async function buildExpandInput(pngBytes, canvas, bounds) {
  const W = canvas.width;
  const H = canvas.height;
  const photoW = bounds.right - bounds.left;
  const photoH = bounds.bottom - bounds.top;
  if (photoW < 1 || photoH < 1 || W < 1 || H < 1) throw problem('IMAGE_DIMENSIONS', '扩图区域无效。');

  const photoPng = await sharp(pngBytes)
    .extract({ left: bounds.left, top: bounds.top, width: photoW, height: photoH })
    .png().toBuffer();
  if (photoW === W && photoH === H) return photoPng;

  const { data, info } = await sharp(photoPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const C = info.channels;
  const out = Buffer.alloc(W * H * C);
  const band = Math.max(8, Math.min(EXTRAP_BAND_MAX, Math.round(Math.min(photoW, photoH) / 12)));
  const px = (x, y) => {
    const i = (y * photoW + x) * C;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const left = bounds.left;
  const right = bounds.left + photoW;
  // 第一步：把照片逐行放进画布，行方向先做一次钳制（上下扩图时上下两半各自
  // 取最近的一行，稍后再按列趋势重算，这里只是给后面两步一个可用的底子）。
  for (let y = 0; y < H; y++) {
    const ry = y - bounds.top;
    const sy = ry < 0 ? 0 : ry >= photoH ? photoH - 1 : ry;
    const srcRow = sy * photoW * C;
    for (let x = 0; x < photoW; x++) {
      const di = (y * W + (x + left)) * C;
      const si = srcRow + x * C;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }

  // 第二步：上下方向外推。按列看边界那一行往里取趋势，竖直结构（墙缝、柜边、
  // 灯罩边缘）因此能继续往上/往下走，而不会像逐行复制那样拉出一排横条。
  if (bounds.top > 0 || bounds.bottom < H) {
    const topProfiles = new Array(photoW);
    const bottomProfiles = new Array(photoW);
    for (let x = 0; x < photoW; x++) {
      topProfiles[x] = edgeTrend((i) => px(x, i), photoH, band);
      bottomProfiles[x] = edgeTrend((i) => px(x, photoH - 1 - i), photoH, band);
    }
    for (let y = 0; y < H; y++) {
      const ry = y - bounds.top;
      if (ry >= 0 && ry < photoH) continue;
      const up = ry < 0;
      const d = up ? -ry : ry - photoH + 1;
      for (let x = 0; x < photoW; x++) {
        const prof = up ? topProfiles[x] : bottomProfiles[x];
        const di = (y * W + (x + left)) * C;
        if (prof) {
          const c = extrudeColor(prof, d, band);
          out[di] = c[0]; out[di + 1] = c[1]; out[di + 2] = c[2];
        }
        out[di + 3] = 255;
      }
    }
  }

  // 第三步：左右方向外推。四角已经在第二步里填好，这一步直接读它们自己的
  // 边界列求趋势，所以斜接处不会裂开一道缝。
  //
  // 剖面先整批算完再铺色。逐行现算现铺虽然等价，但整条剖面拿到手以后才有
  // 位置做「按行校正」这类改动（试过一版按行中位数改写边缘色，出了彩条，已放弃）。
  if (left > 0 || right < W) {
    const leftProfiles = left > 0 ? new Array(H) : null;
    const rightProfiles = right < W ? new Array(H) : null;
    for (let y = 0; y < H; y++) {
      const row = y * W * C;
      const at = (i) => [out[row + i * C], out[row + i * C + 1], out[row + i * C + 2]];
      if (leftProfiles) leftProfiles[y] = edgeTrend((i) => at(left + i), photoW, band);
      if (rightProfiles) rightProfiles[y] = edgeTrend((i) => at(right - 1 - i), photoW, band);
    }
    for (let y = 0; y < H; y++) {
      const row = y * W * C;
      if (leftProfiles && leftProfiles[y]) {
        const prof = leftProfiles[y];
        for (let x = 0; x < left; x++) {
          const di = row + x * C;
          const c = extrudeColor(prof, left - x, band);
          out[di] = c[0]; out[di + 1] = c[1]; out[di + 2] = c[2]; out[di + 3] = 255;
        }
      }
      if (rightProfiles && rightProfiles[y]) {
        const prof = rightProfiles[y];
        for (let x = right; x < W; x++) {
          const di = row + x * C;
          const c = extrudeColor(prof, x - right + 1, band);
          out[di] = c[0]; out[di + 1] = c[1]; out[di + 2] = c[2]; out[di + 3] = 255;
        }
      }
    }
  }

  // 只做 1px 软化，抹掉逐行趋势在边界处的一像素台阶。
  // 早先这里压到 sigma 28（延伸区糊成平滑渐变），模型认为那块「本来就是虚化背景」，
  // 原样返回、一个像素都不重绘——右侧成了一坨平色块。底稿必须保留结构，只能微调。
  const base = await sharp(out, { raw: { width: W, height: H, channels: C } }).blur(1).png().toBuffer();
  return sharp(base)
    .composite([{ input: await sharp(photoPng).removeAlpha().png().toBuffer(), left: bounds.left, top: bounds.top }])
    .png().toBuffer();
}

// 面板要拿「原图」和生成结果叠在一起做前后对比。原图不能由面板自己提供：
// CEP 那边 capture.image 是 data URL，UXP 那边是裸 RGBA（前端没有 PNG 编码器），
// 两端各写一套必然分叉。抓图本来就经过服务端解码，顺手压一张小的留在这里最省事。
//
// 尺寸上限 1400：面板最宽 520，两倍屏也够；再大只是把十几 MB 的 PNG 原样搬进面板内存。
// 必须保留 alpha——扩图的新增区在原图里就是透明的，压掉会变成一块黑，看着像「本来就画了黑边」。
const PREVIEW_MAX_SIDE = 1400;
async function previewPng(pngBytes, maxSide = PREVIEW_MAX_SIDE) {
  return sharp(pngBytes)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

module.exports = { decodeCapture, inspectImage, prepareExpansion, buildExpandInput, previewPng };
