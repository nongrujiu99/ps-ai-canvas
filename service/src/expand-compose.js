'use strict';

const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 扩图结果的合成工具。之所以抽成独立模块：不同供应商返回的图尺寸、通道、
// 是否带透明都不一样，但「把新增条带贴回画布、其余保持透明」这一步是共用的，
// 而且它直接决定 CEP 侧 applyExpand 能不能正确裁切——必须两个供应商行为一致。

// 条带贴着原图的哪一条边。扩图只有两类条带：全高的左右条、位于照片宽度内的上下条。
// 分不清这条边就不知道该往哪侧做羽化，接缝会一直是一条硬直线。
function seamEdge(rect, bounds) {
  if (!bounds) return null;
  const coversWidth = rect.left <= bounds.left && rect.right >= bounds.right;
  const coversHeight = rect.top <= bounds.top && rect.bottom >= bounds.bottom;
  if (coversWidth && !coversHeight) return rect.top <= bounds.top ? 'bottom' : 'top';
  if (coversHeight && !coversWidth) return rect.left <= bounds.left ? 'right' : 'left';
  return null;
}

// 接缝融合。
//
// 旧版把生成块按原样贴上去，画布上就留下一条刀切一样的直线：左边是原图的锐利像素，
// 右边是模型重画的内容（色温、亮度、锐度都不一样），第一眼就是「这是拼上去的」。
//
// 注意这里**不能靠降低 alpha 来柔化**。扩图条带两侧的性质完全不同：
// 靠画布内侧那一半下面压着原图，另一半下面是空的。降 alpha 只会让扩展区变成半透明，
// 露出画布底色，接缝变成一条白带——比硬线更难看。
//
// 所以走「颜色延展」：沿接缝逐行取原图那一列的颜色，把它按距离渐变到生成色。
// alpha 全程保持不透明，接缝两侧的亮度/色温因此天然连续。
// 再往里的 96px 上把生成块的整体色偏按距离衰减地补回去——中转站在 1536 档
// 生成的内容普遍偏亮偏冷，只在接缝对齐、20px 外又跳回去，等于把台阶挪了个位置。
// 底图（抓屏得到的画布 + 原照片）只解码一次。
//
// 之前 matchDepth 和 softenSeam 各自 sharp(comp.base) 解一遍，出错时又各自静默吞掉：
// 一旦解码失败，景深对齐和接缝羽化会同时失效，而日志里一个字都没有——用户看到的是
// 一条刀切边，我们这边全绿。这里统一解码并把失败原因写进日志。
async function decodeBase(comp) {
  if (!comp || !comp.base) return null;
  if (comp._baseRaw !== undefined) return comp._baseRaw;
  try {
    comp._baseRaw = await sharp(comp.base).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    comp._baseRaw = null;
    process.stderr.write('[expand] 底图解码失败，景深对齐与接缝羽化将全部跳过：'
      + ((err && err.message) || err) + '\n');
  }
  return comp._baseRaw;
}

// 原图沿接缝那一列/行的颜色。alpha=0 的位置说明那里本来就没有照片，返回 null。
// softenSeam（接缝收口）和 harmonizeStrip（全域色偏对齐）共用这一份读取逻辑，
// 两边对「哪一行是照片边缘」的认定必须一致，否则量的就不是同一条缝。
function seamPhotoColor(baseRaw, b, edge, rect, index) {
  if (!baseRaw || !b) return null;
  const { width: bw, height: bh, channels: bc } = baseRaw.info;
  let x; let y;
  if (edge === 'left') { x = b.right - 1; y = rect.top + index; }
  else if (edge === 'right') { x = b.left; y = rect.top + index; }
  else if (edge === 'top') { x = rect.left + index; y = b.bottom - 1; }
  else { x = rect.left + index; y = b.top; }
  if (x < 0 || y < 0 || x >= bw || y >= bh) return null;
  const i = (y * bw + x) * bc;
  if (bc === 4 && baseRaw.data[i + 3] < 8) return null;
  return [baseRaw.data[i], baseRaw.data[i + 1], baseRaw.data[i + 2]];
}

// 全条带色偏对齐。
//
// softenSeam 只修接缝两侧 colorBand（约 160px）内的过渡。但色偏往往是模型这一单
// 整体的白平衡/曝光偏差——条带深处仍是模型自己的色调，接缝对上了、下半截却明显
// 是另一种颜色。11 月 13 日的真实扩图就是：接缝实测差 22.2 灰阶，补了 160px，
// 285px 的条带下面那 120px 原样留着，用户一眼看出「色差」。
//
// 做法：在接缝刚进去的 4~20px 处（这里条带内容几乎总是照片边缘的延续，逐列差里
// 「内容本来就不同」的成分最小）逐列算「照片边缘色 − 条带色」，取**中位数**——
// 个别列内容对不上（键盘下面画成了桌面）会被中位数丢掉，留下的只是系统性偏差。
// 中位数超过 ±24 灰阶时按 24 封顶：那么大的差多半不是色偏而是内容不同，硬拉
// 整块会把画面压出色带。拿到偏差后整块加回，再做接缝色延展——那时 softenSeam
// 量到的就只剩局部残差，不会重复补偿。
const HARMONIZE_MAX = 24;
const HARMONIZE_MIN = 3;

async function harmonizeStrip(region, rect, edge, comp) {
  if (!edge || !comp.bounds) return region;
  const baseRaw = await decodeBase(comp);
  if (!baseRaw) return region;
  const { data, info } = await sharp(region).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;
  const horizontal = edge === 'left' || edge === 'right';
  const count = horizontal ? H : W;
  const limit = horizontal ? W : H;
  if (limit < 24) return region;
  const d0 = 4;
  const d1 = Math.min(limit - 1, 20);
  const deltas = [[], [], []];
  for (let k = 0; k < count; k += 2) {
    const e = seamPhotoColor(baseRaw, comp.bounds, edge, rect, k);
    if (!e) continue;
    const sum = [0, 0, 0];
    let n = 0;
    for (let d = d0; d <= d1; d++) {
      const x = horizontal ? (edge === 'left' ? d : W - 1 - d) : k;
      const y = horizontal ? k : (edge === 'top' ? d : H - 1 - d);
      const i = (y * W + x) * C;
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
      n++;
    }
    if (!n) continue;
    for (let c = 0; c < 3; c++) deltas[c].push(e[c] - sum[c] / n);
  }
  if (deltas[0].length < 8) return region;
  const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const delta = [0, 1, 2].map((c) => Math.max(-HARMONIZE_MAX, Math.min(HARMONIZE_MAX, median(deltas[c]))));
  const peak = Math.max(Math.abs(delta[0]), Math.abs(delta[1]), Math.abs(delta[2]));
  if (peak < HARMONIZE_MIN) return region;
  for (let i = 0; i < data.length; i += C) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c] + delta[c];
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  process.stderr.write('[expand] 条带(' + edge + ') 系统性色偏 '
    + delta.map((v) => (v > 0 ? '+' : '') + v.toFixed(1)).join('/')
    + '（' + deltas[0].length + ' 列中位），整块对齐\n');
  return sharp(data, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
}

async function softenSeam(region, rect, edge, comp) {
  if (!edge) return { region, applied: false };
  const meta = await sharp(region).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = meta;
  const W = info.width;
  const H = info.height;
  const C = info.channels;
  // 羽化带宽按短边自适应：固定像素在 800px 的小画布上会吃掉 2% 的画面。
  const shortSide = edge === 'left' || edge === 'right' ? H : W;
  // 羽化带除了跟长边走，还必须跟「条带本身的厚度」走。
  // 只按长边算的时候，一条 3000×200 的窄条带（向下扩 10%）会拿到 24px 羽化，
  // 等于把条带最上面 12% 的像素换成原图边缘那一列的颜色——纹理被抹平，
  // 看上去就是贴边一条发虚的横带。用户截图里「接缝下面一条淡带」正是这么来的。
  const depth = edge === 'left' || edge === 'right' ? W : H;
  const feather = Math.max(4, Math.min(24, Math.round(shortSide * 0.008), Math.round(depth * 0.12)));
  // 色偏补偿必须铺满整条带，不能在前 160px 处归零。
  //
  // 历史：96px 时补偿挤成一条略暗的竖带，于是放到 160px；但 160 是**绝对像素**上限，
  // 在 8MP 大图上只占条带厚度的两三成（2600×3088 的扩图，右侧条带厚 552px）。
  // 后果不是「补不够」而是「补到一半突然停」：0~160px 里梯度被摊平，160px 之后
  // 又回到模型原色，等于在条带中间埋了第二条接缝。实测用户那张图的残差不是贴着
  // 接缝的那一圈，而是「离接缝一百多像素外整块偏亮 7 灰阶」——正是这里断掉的。
  //
  // 补偿量本身很小（封顶 ±34），摊到整条厚度上每像素只变零点几灰阶，不可能过曝；
  // 而归零点被推到条带最外侧，那里本来就是模型自由发挥的区域，没有可对齐的结构。
  const colorBand = Math.max(feather * 4, depth);

  const baseRaw = await decodeBase(comp);
  const b = comp.bounds;
  const edgeColorAt = (index) => seamPhotoColor(baseRaw, b, edge, rect, index);

  // ── 补偿量：二维低频场，而不是一条一维曲线 ─────────────────────────────
  //
  // 一维曲线默认「接缝两侧的偏差沿接缝方向处处相同」。实测差得很远：
  // 一张 2600×2560 的扩图（照片 2048×2560、右侧扩 552px），照片右边缘自上而下
  // 从亮墙（L 209）走到暗书架（L 45）、再回到皮肤（L 150），模型生成的那条墙
  // 却是均匀的。一维补偿只能取一个全局中位，于是同一张图上逐段残差从 -78 到
  // +128 都有：亮处补不够（右边整块发白）、暗处补过头（压出暗带）。
  // 用户说「太明显了」就是前者——离接缝 400px 处还差 53 灰阶。
  //
  // 所以补偿量做成「接缝方向 × 深度方向」的二维网格：每格取该处
  // 「照片边缘色 − 生成色」的中位（中位对格子里恰好有物体免疫），平滑后插值。
  // 亮墙对亮墙、暗书架对暗书架，各抹各的偏差，而不是全条带共用一个数。
  const horizontal = edge === 'left' || edge === 'right';
  const along = horizontal ? H : W;

  // 每行/每列的原图边缘色预处理一次：下面要遍历几百万像素，逐像素做闭包调用太慢。
  const edgeColors = new Array(along);
  let usableEdges = 0;
  for (let k = 0; k < along; k++) {
    edgeColors[k] = edgeColorAt(k);
    if (edgeColors[k]) usableEdges++;
  }

  // 底图上只有照片盖住的那一段才有「接缝」可比，条带超出照片的部分必须排除。
  // 2600×3088 的画布配 2048×2560 的照片时，右侧条带下方 528 行在底图是透明的：
  // 「照片侧均值」只统计了 83% 的行、「生成侧均值」却统计了 100%，两边天生差一截，
  // 补偿会算成正数——本该压暗变成提亮，越修越偏。
  const span = horizontal
    ? Math.min(H, b ? b.bottom - rect.top : H)
    : Math.min(W, b ? b.right - rect.left : W);
  const validEnd = Math.max(2, Math.min(along, span));

  const medianOf = (arr) => { const s = arr.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  // 补偿量要封顶，而且**上限随深度放宽**：
  //   贴着接缝的一段只要补得多，就必然在原图旁边压出一道色带——不管补偿方向对不对；
  //   条带深处是模型自己发挥的区域，那里跟照片色调对齐正是补偿的意义所在。
  // 实测同一张图：接缝近处只差 12 灰阶、深处差 77 灰阶。用一个上限两头都不对——
  // 松了会在接缝旁压出暗带，紧了深处那 77 级根本补不动（用户看到的「右边整块发白」）。
  // 所以近处只给 26、远处给到 130，中间线性过渡；膝盖以下全额、以上渐饱和。
  const capAt = (frac) => 26 + 104 * Math.max(0, Math.min(1, frac));
  const softCap = (v, cap) => {
    const a = Math.abs(v);
    const knee = cap * 0.72;
    if (a <= knee) return v;
    const t = (a - knee) / Math.max(1e-6, cap - knee);
    return (v < 0 ? -1 : 1) * (knee + (cap - knee) * (1 - Math.exp(-t)));
  };

  const GRID_D = Math.max(3, Math.min(16, Math.round(colorBand / 40)));
  const GRID_S = Math.max(3, Math.min(40, Math.round(validEnd / 64)));
  const cellD = colorBand / GRID_D;
  const cellS = validEnd / GRID_S;
  let field = null;   // Float32Array[GRID_S][colorBand][3]，已按深度插值

  if (usableEdges > 0) {
    const grid = new Float32Array(GRID_D * GRID_S * 3);
    let measured = 0;
    for (let gs = 0; gs < GRID_S; gs++) {
      const s0 = Math.floor(gs * cellS);
      const s1 = Math.min(validEnd, Math.floor((gs + 1) * cellS));
      if (s1 - s0 < 2) continue;
      const stepS = Math.max(1, Math.round((s1 - s0) / 32));
      for (let gd = 0; gd < GRID_D; gd++) {
        const d0 = Math.floor(gd * cellD);
        const d1 = Math.min(colorBand, Math.floor((gd + 1) * cellD));
        if (d1 - d0 < 1) continue;
        const stepD = Math.max(1, Math.round((d1 - d0) / 8));
        const diff = [[], [], []];
        for (let k = s0; k < s1; k += stepS) {
          const e = edgeColors[k];
          if (!e) continue;
          for (let d = d0; d < d1; d += stepD) {
            const x = horizontal ? (edge === 'left' ? d : W - 1 - d) : k;
            const y = horizontal ? k : (edge === 'top' ? d : H - 1 - d);
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const i = (y * W + x) * C;
            if (C === 4 && data[i + 3] < 8) continue;
            diff[0].push(e[0] - data[i]);
            diff[1].push(e[1] - data[i + 1]);
            diff[2].push(e[2] - data[i + 2]);
          }
        }
        const at = (gs * GRID_D + gd) * 3;
        const cap = capAt((gd + 0.5) / GRID_D);
        for (let c = 0; c < 3; c++) {
          grid[at + c] = diff[c].length >= 4 ? softCap(medianOf(diff[c]), cap) : NaN;
        }
        if (diff[0].length >= 4) measured++;
      }
    }
    if (measured > 0) {
      // 空格子（照片没盖到的行、或条带太薄）用邻居填，免得插值时突然塌到 0。
      for (let gs = 0; gs < GRID_S; gs++) {
        for (let gd = 0; gd < GRID_D; gd++) {
          const at = (gs * GRID_D + gd) * 3;
          if (!Number.isNaN(grid[at])) continue;
          const nb = [];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const yy = gs + dy; const xx = gd + dx;
              if (yy < 0 || yy >= GRID_S || xx < 0 || xx >= GRID_D) continue;
              const j = (yy * GRID_D + xx) * 3;
              if (!Number.isNaN(grid[j])) nb.push(j);
            }
          }
          for (let c = 0; c < 3; c++) {
            if (!nb.length) { grid[at + c] = 0; continue; }
            let sum = 0;
            for (let n = 0; n < nb.length; n++) sum += grid[nb[n] + c];
            grid[at + c] = sum / nb.length;
          }
        }
      }
      // 一遍 3×3 平滑：格与格之间本来就有台阶，插值只能插成折痕。
      // 只做一遍——多一遍会把「照片边缘上下差别很大」的地方（亮墙 / 暗书架）
      // 抹成一条过渡带，反而把该分开补的两段混在一起。
      for (let pass = 0; pass < 1; pass++) {
        const cp = grid.slice();
        for (let gs = 0; gs < GRID_S; gs++) {
          for (let gd = 0; gd < GRID_D; gd++) {
            const at = (gs * GRID_D + gd) * 3;
            for (let c = 0; c < 3; c++) {
              let sum = 0; let n = 0;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const yy = gs + dy; const xx = gd + dx;
                  if (yy < 0 || yy >= GRID_S || xx < 0 || xx >= GRID_D) continue;
                  sum += cp[(yy * GRID_D + xx) * 3 + c]; n++;
                }
              }
              grid[at + c] = sum / n;
            }
          }
        }
      }
      // 展开成「每格 × 逐深度像素」的表，主循环里只剩一次一维插值。
      field = new Float32Array(GRID_S * colorBand * 3);
      for (let gs = 0; gs < GRID_S; gs++) {
        for (let d = 0; d < colorBand; d++) {
          const fd = d / cellD - 0.5;
          let x0 = Math.floor(fd);
          if (x0 < 0) x0 = 0;
          if (x0 > GRID_D - 1) x0 = GRID_D - 1;
          const x1 = Math.min(GRID_D - 1, x0 + 1);
          let td = fd - x0;
          if (td < 0) td = 0;
          const sm = td * td * (3 - 2 * td);
          const a3 = (gs * GRID_D + x0) * 3;
          const b3 = (gs * GRID_D + x1) * 3;
          const o = (gs * colorBand + d) * 3;
          for (let c = 0; c < 3; c++) {
            field[o + c] = grid[a3 + c] + (grid[b3 + c] - grid[a3 + c]) * sm;
          }
        }
      }
      const probe = (gs) => {
        const o = (gs * colorBand + Math.max(0, Math.round(colorBand * 0.9))) * 3;
        return [field[o], field[o + 1], field[o + 2]]
          .map((v) => (v > 0 ? '+' : '') + v.toFixed(0)).join('/');
      };
      // 补偿量必须留痕：接缝仍是一条淡带时，靠这行能分清是「量错了」还是「补了但不够」。
      process.stderr.write('[expand] 接缝(' + edge + ') 二维补偿场 '
        + GRID_D + '×' + GRID_S + ' 格（' + Math.round(cellD) + 'px × ' + Math.round(cellS) + 'px）'
        + ' 深度90%处 上段 ' + probe(1) + '、中段 ' + probe(Math.floor(GRID_S / 2))
        + '、下段 ' + probe(GRID_S - 2) + '\n');
    }
  }

  // 一张边缘色都取不到（底图缺失 / 整条接缝落在透明区）时，这个函数其实什么都没做：
  // 色延展的起点退化成生成色本身，接缝仍是刀切。把这件事如实报出去，交给下面的自检兜底。
  const applied = usableEdges > 0 && field !== null;

  const xs = edge === 'left' ? [0, Math.min(W, colorBand)]
    : edge === 'right' ? [Math.max(0, W - colorBand), W]
      : [0, W];
  const ys = edge === 'top' ? [0, Math.min(H, colorBand)]
    : edge === 'bottom' ? [Math.max(0, H - colorBand), H]
      : [0, H];

  // 沿接缝方向做一次一维插值，取该像素应补的色差。
  // 复用同一个数组：主循环要跑几百万次，逐像素返回新数组会把 GC 压爆。
  const scratch = new Float32Array(3);
  const fieldAt = (d, k) => {
    const fk = k / cellS - 0.5;
    let s0 = Math.floor(fk);
    if (s0 < 0) s0 = 0;
    if (s0 > GRID_S - 1) s0 = GRID_S - 1;
    const s1 = Math.min(GRID_S - 1, s0 + 1);
    let ts = fk - s0;
    if (ts < 0) ts = 0;
    const a = (s0 * colorBand + d) * 3;
    const bb = (s1 * colorBand + d) * 3;
    scratch[0] = field[a] + (field[bb] - field[a]) * ts;
    scratch[1] = field[a + 1] + (field[bb + 1] - field[a + 1]) * ts;
    scratch[2] = field[a + 2] + (field[bb + 2] - field[a + 2]) * ts;
    return scratch;
  };

  for (let y = ys[0]; y < ys[1]; y++) {
    for (let x = xs[0]; x < xs[1]; x++) {
      const d = edge === 'left' ? x : edge === 'right' ? W - 1 - x : edge === 'top' ? y : H - 1 - y;
      if (d >= colorBand) continue;
      const i = (y * W + x) * C;
      const k = horizontal ? y : x;
      const comp = field ? fieldAt(d, k) : null;
      const c0 = edgeColors[k];
      if (d < feather) {
        // 接缝处完全用原图那一列的颜色，往里过渡到「生成色 + 补偿」。
        const t = d / feather;
        for (let c = 0; c < 3; c++) {
          const gen = data[i + c] + (comp ? comp[c] : 0);
          const from = c0 ? c0[c] : gen;
          const v = from + (gen - from) * t;
          data[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        }
      } else if (comp) {
        for (let c = 0; c < 3; c++) {
          const v = data[i + c] + comp[c];
          data[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        }
      }
    }
  }
  return { region: await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toBuffer(), applied };
}

// 接缝台阶自检。
//
// 上面那套「色延展 + 色偏衰减」是按设计走的，但它依赖一件硬条件：能从底图上取到
// 接缝那一列的颜色。取不到时（底图解码失败、接缝整条落在透明区、方向判错）它会
// 静悄悄地什么都不做——起点退化成生成色本身，成品上留一条刀切边，而日志全绿。
//
// 实测撞上过：放大看接缝是一条明显的亮带（照片侧 105 灰阶、生成侧 112，过渡只有
// 十几像素，再往里还有两三百像素的亮晕）。所以补一道兜底：只在 softenSeam 明确
// 报告「我没做成」时才跑，直接从成品上量接缝两侧的差，差多少补多少。
//
// 只在没做成时跑，是为了不和正常路径打架——色延展做成功时接缝本来就是连续的，
// 再叠一层补偿只会把已经对的图推向另一边（第一版就是这么翻车的）。
// 用逐行差的中位数而不是均值：两侧内容本来就不同（左边是手、右边是墙），
// 均值会被这些结构性差异带偏；台阶对每一行都成立，中位数只认它。
function seamStep(data, W, H, C, baseRaw, b, edge, rect, from, to) {
  const { data: bd, info: bi } = baseRaw;
  const bw = bi.width;
  const bh = bi.height;
  const bc = bi.channels;
  const horizontal = edge === 'left' || edge === 'right';
  const rows = horizontal ? H : W;
  const limit = horizontal ? W : H;
  if (limit < 8) return null;
  const d0 = Math.max(0, Math.min(from, limit - 1));
  const d1 = Math.max(d0, Math.min(to, limit - 1));
  // 照片侧要避开条带重叠的那 1px：拿它和自己比永远等于 0，量不出东西。
  const p0 = d0 + 2;
  const p1 = d1 + 3;
  const diffs = [[], [], []];
  for (let k = 0; k < rows; k += 3) {
    const sum = [0, 0, 0];
    let n = 0;
    for (let d = d0; d <= d1; d++) {
      const x = horizontal ? (edge === 'left' ? d : W - 1 - d) : k;
      const y = horizontal ? k : (edge === 'top' ? d : H - 1 - d);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * C;
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
      n++;
    }
    if (!n) continue;
    const psum = [0, 0, 0];
    let pn = 0;
    for (let d = p0; d <= p1; d++) {
      let x; let y;
      if (edge === 'left') { x = b.right - 1 - d; y = rect.top + k; }
      else if (edge === 'right') { x = b.left + d; y = rect.top + k; }
      else if (edge === 'top') { x = rect.left + k; y = b.bottom - 1 - d; }
      else { x = rect.left + k; y = b.top + d; }
      if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
      const i = (y * bw + x) * bc;
      if (bc === 4 && bd[i + 3] < 8) continue;
      psum[0] += bd[i]; psum[1] += bd[i + 1]; psum[2] += bd[i + 2];
      pn++;
    }
    if (!pn) continue;
    for (let c = 0; c < 3; c++) diffs[c].push(sum[c] / n - psum[c] / pn);
  }
  if (!diffs[0].length) return null;
  const step = diffs.map((arr) => {
    const s = arr.slice().sort((a, b2) => a - b2);
    return s[Math.floor(s.length / 2)];
  });
  return { step, rows: diffs[0].length };
}

async function enforceSeamContinuity(region, rect, edge, comp) {
  if (!edge) return region;
  const baseRaw = await decodeBase(comp);
  if (!baseRaw || !comp.bounds) return region;
  const { data, info } = await sharp(region).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const C = info.channels;
  const horizontal = edge === 'left' || edge === 'right';
  const shortSide = horizontal ? H : W;
  const span = horizontal ? W : H;
  const peakOf = (p) => Math.max(Math.abs(p.step[0]), Math.abs(p.step[1]), Math.abs(p.step[2]));

  const gate = seamStep(data, W, H, C, baseRaw, comp.bounds, edge, rect, 1, 4);
  if (!gate) return region;
  // 1.5 灰阶是舍入噪声的量级。这条路径只在色延展没做成时进来，条带靠接缝的
  // 那几像素就是模型的原始输出，没有渐变色混淆，量到的就是硬边的真实高度。
  if (peakOf(gate) < 1.5) return region;
  const source = gate;

  // 补偿上限：两侧内容本来就不同时（左边深色笔记本、右边亮墙）台阶会很大，
  // 那不是色偏，硬拉会把暗部提亮。只补到 16 灰阶，剩下的交给用户判断。
  const step = source.step.map((v) => Math.max(-16, Math.min(16, v)));
  // 拉平带宽：既盖住「过渡只有十几像素」的硬边，又不能一路摊到整块去改色调。
  // 上限还要受条带自身尺寸约束，否则短条带上衰减没走完就断了，反而多出一个台阶。
  const band = Math.max(24, Math.min(360, Math.round(shortSide * 0.05), span));
  for (let k = 0; k < (horizontal ? H : W); k++) {
    for (let d = 0; d < band; d++) {
      let x; let y;
      if (edge === 'left') { x = d; y = k; }
      else if (edge === 'right') { x = W - 1 - d; y = k; }
      else if (edge === 'top') { x = k; y = d; }
      else { x = k; y = H - 1 - d; }
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * C;
      const f = 1 - d / band;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c] - step[c] * f;
        data[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  process.stderr.write('[expand] 接缝(' + edge + ')没接上（色延展没做成），实测台阶 '
    + source.step.map((v) => (v > 0 ? '+' : '') + v.toFixed(1)).join('/')
    + '，按 ' + step.map((v) => (v > 0 ? '+' : '') + v.toFixed(1)).join('/')
    + ' 灰阶在 ' + band + 'px 内拉平（样本 ' + source.rows + ' 行）\n');
  return sharp(data, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
}

// 分块取中位数的细节能量。
//
// 直接用整块平均会被两头骗：原图那一带如果只角上有一根手指（超高频），平均会被拉高，
// 基准虚高 → 该压的延伸区压不下去；反过来，延伸区如果是一大片平滑墙加一根锐边，
// 平均又被摊薄 → 看起来"更平"，其实边缘比原图锐得多。
// 分块看中位数，比的才是「这片区域典型的一个小块有多清楚」。
function detailMedian(raw, x0, x1, y0, y1, tiles = 4) {
  const samples = [];
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const tx0 = x0 + ((x1 - x0) / tiles) * i;
      const tx1 = x0 + ((x1 - x0) / tiles) * (i + 1);
      const ty0 = y0 + ((y1 - y0) / tiles) * j;
      const ty1 = y0 + ((y1 - y0) / tiles) * (j + 1);
      const v = detailEnergy(raw, tx0, tx1, ty0, ty1);
      if (v > 0) samples.push(v);
    }
  }
  if (!samples.length) return 0;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}


// 景深对齐。
//
// 这是「接不上」最刺眼的一种表现，而且和内容对不对无关：模型把延伸区画得比原照片
// 清楚一大截。原图是浅景深虚化的室内照（背景一片奶油色散景），延伸区却给出了
// 边缘锐利、细节清楚的架子和地板——哪怕内容恰好接得上，眼睛也会立刻判断「这是拼的」。
//
// 提示词里已经写了「清晰度必须一致」，但模型对「虚」这件事几乎不敏感：给它一块
// 均匀色带，它倾向于补充细节。所以要在合成这一层兜住：量出原图紧邻接缝那条带的
// 清晰度，再把延伸区往同一水平压。
//
// 只做单向：延伸区更清楚才压，更糊就不动（模糊不能凭空生出细节，硬提只会出噪点）。
async function matchDepth(region, rect, edge, comp) {
  if (!edge || !comp.bounds) return { region, ratio: null };
  const baseRaw = await decodeBase(comp);
  if (!baseRaw) return { region, ratio: null };
  const b = comp.bounds;
  const bw = baseRaw.info.width;
  const bh = baseRaw.info.height;
  if (!bw || !bh) return { region, ratio: null };

  // 原图紧邻接缝的一条：横向扩图取接缝那一侧 12% 宽度，纵向取 12% 高度。
  // 不能取得太宽——取宽了会混进照片深处的清晰主体，基准被抬上去，压不住。
  const photoW = Math.max(1, b.right - b.left);
  const photoH = Math.max(1, b.bottom - b.top);
  const horizontal = edge === 'left' || edge === 'right';
  const bandW = Math.max(48, Math.round((horizontal ? photoW : rect.right - rect.left) * 0.12));
  const bandH = Math.max(48, Math.round((horizontal ? rect.bottom - rect.top : photoH) * 0.12));
  let bx0;
  let by0;
  if (edge === 'right') { bx0 = b.right - bandW; by0 = rect.top; }
  else if (edge === 'left') { bx0 = b.left; by0 = rect.top; }
  else if (edge === 'bottom') { bx0 = rect.left; by0 = b.bottom - bandH; }
  else { bx0 = rect.left; by0 = b.top; }
  const photoDetail = detailMedian(baseRaw, bx0, bx0 + bandW, by0, by0 + bandH, 4);
  // 基准太低（原图那一带几乎没变化，比如一堵平墙）时不做对齐：
  // 这时候比例没有意义，压下去会把本来该有的细节糊掉。
  if (!(photoDetail > 0.35)) return { region, ratio: null };

  let raw;
  try { raw = await sharp(region).removeAlpha().raw().toBuffer({ resolveWithObject: true }); }
  catch (_) { return { region, ratio: null }; }
  const extDetail = detailMedian(raw, 0, raw.info.width, 0, raw.info.height, 4);
  const ratio = extDetail / photoDetail;
  // 1.35 倍以内算正常抖动：不同模型对「虚」的把握本来就有偏差，追太紧会把
  // 本来就对的图反复重采样，白损失锐度。
  if (ratio <= 1.35 && ratio >= 1 / 1.35) return { region, ratio };

  // 反方向：条带比原图更虚。
  //
  // 模型给的延伸区常常是「低一档分辨率再放大回来」的（Express 2K 档往 3000px 上
  // 一贴就是这样），像素是对的、细节没了。以前这里直接返回，于是色对上了、
  // 清晰度没对上，肉眼看到的就是接缝下面一条糊带——用户不会说「分辨率低」，
  // 只会说「有色差」，因为发虚同时伴随对比度下降。
  // 只补到原图的九成：追平会开始出锐化边缘，反而更像贴上去的。
  if (ratio < 1 / 1.35) {
    let current = region;
    let currentDetail = extDetail;
    const target = photoDetail * 0.9;
    for (const sigma of [0.6, 0.9, 1.3, 1.8, 2.4, 3]) {
      let sharpened;
      try {
        sharpened = await sharp(region).sharpen({ sigma, m1: 0.6, m2: 1.2 }).png().toBuffer();
      } catch { break; }
      let sharpenedRaw;
      try { sharpenedRaw = await sharp(sharpened).removeAlpha().raw().toBuffer({ resolveWithObject: true }); }
      catch { break; }
      currentDetail = detailMedian(sharpenedRaw, 0, sharpenedRaw.info.width, 0, sharpenedRaw.info.height, 4);
      current = sharpened;
      if (currentDetail >= target) break;
    }
    if (currentDetail > photoDetail * 1.1) return { region, ratio };
    return { region: current, ratio: currentDetail / photoDetail };
  }

  let current = region;
  let currentDetail = extDetail;
  for (const sigma of [0.8, 1.2, 1.8, 2.6, 3.6, 5, 7]) {
    const blurred = await sharp(region).blur(sigma).png().toBuffer();
    let blurredRaw;
    try { blurredRaw = await sharp(blurred).removeAlpha().raw().toBuffer({ resolveWithObject: true }); }
    catch (_) { break; }
    currentDetail = detailMedian(blurredRaw, 0, blurredRaw.info.width, 0, blurredRaw.info.height, 4);
    current = blurred;
    if (currentDetail <= photoDetail * 1.15) break;
  }
  return { region: current, ratio: currentDetail / photoDetail };
}

// 「接缝到底差在哪一步」用日志量不出来：差的是色、是清晰度、还是羽化带太宽，
// 只有把「模型交回来的那块条带」和「合成后的条带」并排看才知道。
// 默认不写盘；设 STUDIO_DUMP=1 才落盘，文件名带序号，1- 是模型原样、2- 是合成后。
function dumpStrip(stage, index, bytes) {
  if (!process.env.STUDIO_DUMP) return;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  const dir = path.join(base, 'Studio AI Image', 'dump');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, stage + '-' + index + '-' + Date.now() + '.png'), bytes);
  } catch (_) {
    // 落盘失败绝不影响出图
  }
}

// 模型只回了一块窗口（或一张被缩放过的整图），这里把它按窗口尺寸对齐，
// 再把条带逐条抠出来贴到画布大小的透明底上：只有新增区有像素，原照片区 alpha=0。
// CEP 侧只认「画布尺寸 + 只有新增区有像素」这一种结果，别的形态都会被当成未裁切。
async function composeExpand(bytes, comp) {
  const winW = comp.window.right - comp.window.left;
  const winH = comp.window.bottom - comp.window.top;
  const shot = await sharp(bytes).resize(winW, winH, { fit: 'fill' }).png().toBuffer();
  const layers = [];
  for (const s of comp.strips) {
    let region = await sharp(shot)
      .extract({
        left: s.left - comp.window.left,
        top: s.top - comp.window.top,
        width: s.right - s.left,
        height: s.bottom - s.top
      })
      .png().toBuffer();
    dumpStrip('1-model', layers.length, region);
    const edge = seamEdge(s, comp.bounds);
    // 顺序固定：先整块对齐模型的系统性色偏，再压景深，最后接缝色延展。
    // 景深对齐只看细节能量、不受色偏影响；色延展量到的「生成区色偏」在对齐后
    // 只剩局部残差，不会再把同一笔偏差补两遍。
    region = await harmonizeStrip(region, s, edge, comp);
    const depth = await matchDepth(region, s, edge, comp);
    region = depth.region;
    if (depth.ratio !== null && depth.ratio > 1.35) {
      process.stderr.write('[expand] 延伸区比原图清楚 ' + depth.ratio.toFixed(2) + ' 倍，已压到同一景深\n');
    } else if (depth.ratio !== null && depth.ratio < 0.72) {
      process.stderr.write('[expand] 延伸区只有原图 ' + depth.ratio.toFixed(2) + ' 的细节，已补锐度（发虚是「有色差」的另一半原因）\n');
    }
    const softened = await softenSeam(region, s, edge, comp);
    region = softened.region;
    // 色延展没做成 → 接缝还是刀切的，用实测台阶兜一次。做成了就不碰，
    // 免得把已经连续的过渡又推歪。
    if (!softened.applied) region = await enforceSeamContinuity(region, s, edge, comp);
    if (!edge) {
      process.stderr.write('[expand] 条带 ' + JSON.stringify(s) + ' 判断不出贴的是照片哪条边，跳过接缝羽化\n');
    }
    dumpStrip('2-composed', layers.length, region);
    layers.push({ input: region, left: s.left, top: s.top });
  }
  return sharp({
    create: { width: comp.frame.width, height: comp.frame.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite(layers).png().toBuffer();
}

// 判断「模型到底有没有在扩展区画东西」。
//
// 这是「生成内容不符」最隐蔽的一种表现：请求成功、图也回来了、合成和落位全都没报错，
// 但扩展区其实是上传时那张模糊底稿原封不动地被交回来——一个像素都没重绘。
// 用户看到的就是右边接了一块白雾或纯色，而日志里一切正常。
//
// 判据不依赖任何主观阈值之外的东西：把模型输出和上传的底稿在扩展区逐像素对比。
// 同一块区域如果几乎一样（平均差 < 3.5 灰阶、六成以上像素差 ≤ 3），说明模型只是把它
// 原样传了回来；另一种情况是它重画了，但画成了一片接近纯白/纯黑的空块，用亮部占比兜住。
// 一块区域的「细节能量」：每个像素与周围 5×5 均值的平均偏差。
// 它不看颜色，只看有没有起伏——平涂、均匀渐变、整块模糊的数值都接近 0，
// 而真实照片（哪怕背景虚化）总有噪点、边缘和光影过渡。
function detailEnergy(raw, x0, x1, y0, y1, stride = 4) {
  const { data, info } = raw;
  const W = info.width;
  const C = info.channels;
  const luma = (x, y) => {
    const i = (y * W + x) * C;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  let sum = 0;
  let n = 0;
  const xs0 = Math.max(2, Math.floor(x0) + 2);
  const xs1 = Math.min(W - 2, Math.ceil(x1) - 2);
  const ys0 = Math.max(2, Math.floor(y0) + 2);
  const ys1 = Math.min(info.height - 2, Math.ceil(y1) - 2);
  for (let y = ys0; y < ys1; y += stride) {
    for (let x = xs0; x < xs1; x += stride) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m += luma(x + dx, y + dy);
      m /= 25;
      sum += Math.abs(luma(x, y) - m);
      n++;
    }
  }
  return n ? sum / n : 0;
}

async function extensionFidelity(candidate, prefill, strips, canvas, bounds = null, options = {}) {
  const meta = await sharp(candidate).metadata();
  const W = meta.width;
  const H = meta.height;
  if (!W || !H || !prefill || !strips || !strips.length) return { checked: false };

  const cand = await sharp(candidate).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // 底稿在请求时被缩放到 API 尺寸，模型回来又缩回画布尺寸；这里统一到模型输出的尺寸上比，
  // 少一次重采样，差值才不会虚高。
  const ref = await sharp(prefill).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const C = cand.info.channels;
  const R = ref.info.channels;
  const sx = W / canvas.width;
  const sy = H / canvas.height;

  let diff = 0;
  let near = 0;
  let white = 0;
  let n = 0;
  // 底稿在扩展区本身是否还有起伏。底稿是一片纯色时（原图边缘本来就是一块平墙），
  // 「回来的图也接近纯色」证明不了模型没画——它可能真的画了一面同色的墙。
  let refSum = 0;
  let refSquare = 0;
  // 照片区的漂移：模型有没有把「不该动的地方」也重画了。
  // 这是「接不上」最有力的证据——mask 明明只标了条带，模型却整张重画时，
  // 它画的延伸区一定是自己重新构图的结果，跟原图对不上是必然的。
  let photoDiff = 0;
  let photoN = 0;
  const photoBox = bounds ? {
    x0: (bounds.left + (bounds.right - bounds.left) * 0.12) * sx,
    x1: (bounds.right - (bounds.right - bounds.left) * 0.12) * sx,
    y0: (bounds.top + (bounds.bottom - bounds.top) * 0.12) * sy,
    y1: (bounds.bottom - (bounds.bottom - bounds.top) * 0.12) * sy
  } : null;
  for (const s of strips) {
    // 让出几像素：接缝那一圈会被合成层做颜色延展，本来就不该参与判定。
    const x0 = Math.max(0, Math.floor(s.left * sx) + 3);
    const x1 = Math.min(W, Math.ceil(s.right * sx) - 3);
    const y0 = Math.max(0, Math.floor(s.top * sy) + 3);
    const y1 = Math.min(H, Math.ceil(s.bottom * sy) - 3);
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) {
        const i = (y * W + x) * C;
        const j = (y * W + x) * R;
        const d = (Math.abs(cand.data[i] - ref.data[j])
          + Math.abs(cand.data[i + 1] - ref.data[j + 1])
          + Math.abs(cand.data[i + 2] - ref.data[j + 2])) / 3;
        diff += d;
        if (d <= 3) near++;
        const luma = 0.299 * cand.data[i] + 0.587 * cand.data[i + 1] + 0.114 * cand.data[i + 2];
        if (luma >= 248) white++;
        const refLuma = 0.299 * ref.data[j] + 0.587 * ref.data[j + 1] + 0.114 * ref.data[j + 2];
        refSum += refLuma;
        refSquare += refLuma * refLuma;
        n++;
      }
    }
  }
  if (!n) return { checked: false };
  if (photoBox) {
    for (let y = Math.max(0, Math.floor(photoBox.y0)); y < Math.min(H, Math.ceil(photoBox.y1)); y += 5) {
      for (let x = Math.max(0, Math.floor(photoBox.x0)); x < Math.min(W, Math.ceil(photoBox.x1)); x += 5) {
        const i = (y * W + x) * C;
        const j = (y * W + x) * R;
        photoDiff += (Math.abs(cand.data[i] - ref.data[j])
          + Math.abs(cand.data[i + 1] - ref.data[j + 1])
          + Math.abs(cand.data[i + 2] - ref.data[j + 2])) / 3;
        photoN++;
      }
    }
  }
  const photoDrift = photoN ? photoDiff / photoN : 0;
  const meanDiff = diff / n;
  const nearShare = near / n;
  const whiteShare = white / n;
  const refMean = refSum / n;
  const refSd = Math.sqrt(Math.max(0, refSquare / n - refMean * refMean));

  // 第三种失败：画了，但画成一块没有细节的色带。请求 200、尺寸正常、扩展区也不白，
  // 只是把底稿的颜色往下摊——用户在 PS 里看到右边「糊成一片」，接不上。
  // 判据是细节能量：扩展区必须达到原照片紧邻那条带的 30% 以上。
  let extDetail = 0;
  let photoDetail = 0;
  if (bounds) {
    const areas = strips.map((s) => ({
      x0: s.left * sx, x1: s.right * sx, y0: s.top * sy, y1: s.bottom * sy
    }));
    let dsum = 0;
    for (const a of areas) dsum += detailEnergy(cand, a.x0, a.x1, a.y0, a.y1);
    extDetail = dsum / areas.length;
    // 原照片紧邻接缝的那一条：横向扩图取照片边缘 15% 宽，纵向取 15% 高。
    const photoW = bounds.right - bounds.left;
    const photoH = bounds.bottom - bounds.top;
    const horizontal = canvas.width - (bounds.right - bounds.left) >= canvas.height - photoH;
    // 取照片靠接缝那侧的一块，但纵向只取中间 60%：上下边缘常常本来就空（黑边、
    // 纯墙、桌面边缘），把它们算进基准会把「及格线」拉低，糊图反而过关。
    const bandW = (horizontal ? Math.round(photoW * 0.2) : Math.round(photoW * 0.6)) * sx;
    const bandH = (horizontal ? Math.round(photoH * 0.6) : Math.round(photoH * 0.2)) * sy;
    const x0 = horizontal ? bounds.right * sx - bandW : bounds.left * sx + bandW * 0.5;
    const y0 = horizontal ? bounds.top * sy + (bounds.bottom - bounds.top) * 0.2 * sy : bounds.bottom * sy - bandH;
    photoDetail = detailEnergy(ref, x0, x0 + bandW, y0, y0 + bandH);
  }

  // 原样交回：几乎和底稿一致。底稿没起伏时不判——那种情况下「一致」不说明问题。
  const stale = refSd >= 2 && meanDiff < 2 && nearShare > 0.75;
  // 画了，但画成一片白：扩展区九成以上是接近纯白的像素。
  const blank = whiteShare > 0.85 && meanDiff > 1;
  // 画了，但没细节：细节能量不到原照片同位置的一半。
  // 基准门槛从 1.0 降到 0.5——上一版的 1.0 让「原图本身就是浅景深虚化」的情况
  // 整个判定失效（实测原图那带只有 0.94，扩展区 0.40 也照样放过），
  // 用户看到的就是右边接了一块糊掉的色带，而日志里写着 ok。
  const flat = photoDetail > 0.5 && extDetail < photoDetail * 0.55;
  // 模型重画了照片本体：mask 之外的地方平均差了 10 灰阶以上，不可能是压缩噪声。
  // 这种时候延伸区的内容是模型自己重新构图的结果，跟原图对不上是必然的。
  // 但 bare 形态（只给照片、让它输出更大的构图）本来就要重画整幅，这条不适用。
  const alien = !options.regenerated && photoDrift > 10;

  // 把四种毛病折算成一个可以互相比较的分数，满分 100。
  //
  // 为什么需要这个数：一轮里会用好几种「请求形态」各试一次，它们各自都不完美，
  // 得挑一个最能交差的。以前只有布尔标记，只能按「最后一个失败」处理——
  // 于是三种不同的错法最后都走到同一个结局：报错、什么都不给。
  //
  // 100 是「完全没画」，这种结果没有任何价值，只能报错；其余都在 0~90，
  // 意味着一张有内容、但某方面不够好的图，应该交给用户自己判断。
  let severity = 0;
  if (stale || blank) {
    severity = 100;
  } else {
    if (flat) severity += 30 + Math.min(20, Math.round((1 - extDetail / Math.max(0.01, photoDetail * 0.55)) * 20));
    if (alien) severity += 20 + Math.min(30, Math.round(Math.max(0, photoDrift - 10)));
    // 封顶 95：100 这个档位专门留给「什么都没画」。两种毛病同时犯时（又糊又重画）
    // 很容易凑到 100 以上，那样一张确实有内容的图会被误当成空结果丢掉。
    severity = Math.min(95, severity);
  }

  return {
    checked: true,
    diff: meanDiff,
    nearShare,
    whiteShare,
    refSd,
    extDetail,
    photoDetail,
    photoDrift,
    stale,
    blank,
    flat,
    alien,
    severity
  };
}

// 对 base64 内联图有体积上限的接口，把 PNG 收敛到 8 MB 以内：
// 小图原样走 PNG（无损），大图转高质量 JPEG 并逐级降质。
const API_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const API_IMAGE_QUALITIES = [95, 92, 88, 84, 78, 72, 66, 60, 55, 48, 40];

async function encodeApiImage(bytes, maxBytes = API_IMAGE_MAX_BYTES) {
  if (bytes.length <= maxBytes) return `data:image/png;base64,${bytes.toString('base64')}`;
  let encoded;
  for (const quality of API_IMAGE_QUALITIES) {
    encoded = await sharp(bytes).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
    if (encoded.length <= maxBytes) break;
  }
  return `data:image/jpeg;base64,${encoded.toString('base64')}`;
}

// 把「画布减去照片」拆成新增条带，规则与 aliyun.js / CEP 侧 bridge.jsx 的 newStrips 一致：
// 扩张的那一侧向照片内让 1px，用来盖住比例反解带来的接缝。
function expandStrips(frameW, frameH, b) {
  const strips = [];
  const add = (l, t, r, bottom) => {
    const rect = {
      left: Math.max(0, Math.round(l)),
      top: Math.max(0, Math.round(t)),
      right: Math.min(frameW, Math.round(r)),
      bottom: Math.min(frameH, Math.round(bottom))
    };
    if (rect.right - rect.left >= 1 && rect.bottom - rect.top >= 1) strips.push(rect);
  };
  if (b.left > 0) add(0, 0, b.left + 1, frameH);
  if (b.right < frameW) add(b.right - 1, 0, frameW, frameH);
  if (b.top > 0) add(b.left, 0, b.right, b.top + 1);
  if (b.bottom < frameH) add(b.left, b.bottom - 1, b.right, frameH);
  return strips;
}

// 原照片范围必须真的落在画布里，并且确实存在「够宽的新增区」。
// 为什么必须校验：这个范围一旦偏大（照片边缘有半透明描边、柔和投影、抗锯齿，
// 或者活动图层本身就铺满画布），expandStrips 算出来的条带就会被挤成几个像素宽，
// composeExpand 合成出来是一张「只有一两列像素、其余全透明」的图。CEP 侧照常裁切、
// 照常合并，用户在 Photoshop 里看到的就是「扩图区整片透明、合并后不见了」。
// 这种失败以前是完全静默的，所以宁可在这里挡住并说清楚原因。
function saneBounds(bounds, canvas) {
  if (!bounds || !canvas) return null;
  const left = Math.round(Number(bounds.left));
  const top = Math.round(Number(bounds.top));
  const right = Math.round(Number(bounds.right));
  const bottom = Math.round(Number(bounds.bottom));
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right - left < 16 || bottom - top < 16) return null;
  if (left < 0 || top < 0 || right > canvas.width || bottom > canvas.height) return null;
  // 至少有一侧要留出 8px 以上的新增区，否则这根本不是扩图任务（或范围判错了）。
  if (Math.max(left, canvas.width - right) < 8 && Math.max(top, canvas.height - bottom) < 8) return null;
  return { left, top, right, bottom };
}

// 活动图层的范围只有在「盖住画面不透明像素的大半」时，才能当原照片用。
//
// 踩过的现场：2048×2844 的画布，活动层正好停在底部那条 285 高的透明带上。
// 这个范围通过了 saneBounds（在画布内、够大、确实有新增区），于是被当成原照片：
// 高 285 的分母把上方 2559px 算成了 9.98 倍，直接被 1~2 的上限挡回，面板只好退回
// 手填的默认值——而画布上真实的扩张只有下方 1.11。用户看到的就是「识别不对」。
//
// 不按面积占比拍死（「窄长条要不要能扩」是合法需求），而是问一个更本质的问题：
// 这个范围到底盖住了画面里的哪些像素。盖不住不透明区，它就只是画面的一角。
function photoLikeBounds(bounds, opaque) {
  if (!bounds || !opaque) return null;
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const opaqueArea = area(opaque);
  if (opaqueArea <= 0) return null;
  const overlapWidth = Math.max(0, Math.min(bounds.right, opaque.right) - Math.max(bounds.left, opaque.left));
  const overlapHeight = Math.max(0, Math.min(bounds.bottom, opaque.bottom) - Math.max(bounds.top, opaque.top));
  return (overlapWidth * overlapHeight) / opaqueArea >= 0.5 ? bounds : null;
}

// 从「原照片在画布里的范围」推出四边倍率（1 = 该边没有扩张）。
// 推不出 1~2 之间的合理组合就返回 null，由调用方换一个范围再试，而不是硬塞一个值。
function deriveScales(bounds, canvas) {
  if (!bounds || !canvas) return null;
  const originalWidth = bounds.right - bounds.left;
  const originalHeight = bounds.bottom - bounds.top;
  if (!(originalWidth > 0) || !(originalHeight > 0)) return null;
  const scales = {
    top: 1 + bounds.top / originalHeight,
    right: 1 + (canvas.width - bounds.right) / originalWidth,
    bottom: 1 + (canvas.height - bounds.bottom) / originalHeight,
    left: 1 + bounds.left / originalWidth,
  };
  const usable = Object.values(scales).every((scale) => scale >= 1 && scale <= 2)
    && Object.values(scales).some((scale) => scale > 1);
  return usable ? scales : null;
}

// 「照片范围 → 四边倍率」的逆运算：由倍率反解回照片在画布里的矩形。
//
// 两个方向都要有，是因为这两个值分头走完整个流程：倍率决定遮罩、提示词和贴回时
// 的裁切位置，范围决定「哪一块是原图」。它们只要不一致，模型就会在错误的那侧作画。
// 现场：2048×2844 的画布，倍率算对了（下 1.111），但提交的范围仍是活动图层那条
// 2559~2844 的透明带——服务端按这个范围把上方 2560px 当成原图、把下方 284px 当成
// 新增区，最后贴回底部的是另一块内容，画面上出现一排竖条。
//
// 解不出来（倍率是 1/1/1/1 这类退化组合）就返回 null，由调用方换下一个候选。
function innerRectFromScales(scales, canvas) {
  if (!scales || !canvas) return null;
  const widthRatio = Number(scales.left) + Number(scales.right) - 1;
  const heightRatio = Number(scales.top) + Number(scales.bottom) - 1;
  if (!(widthRatio > 0.2) || !(heightRatio > 0.2)) return null;
  const width = canvas.width / widthRatio;
  const height = canvas.height / heightRatio;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) return null;
  return {
    left: (Number(scales.left) - 1) * width,
    top: (Number(scales.top) - 1) * height,
    right: canvas.width - (Number(scales.right) - 1) * width,
    bottom: canvas.height - (Number(scales.bottom) - 1) * height
  };
}

// 提交前的最后一道范围校验：客户端给的范围如果只是画面的一角（活动图层停在透明带上），
// 就用「倍率反解」或「alpha 包围盒」把它换掉，再交给供应商做遮罩。
//
// 为什么要在这一层兜：面板是源码副本，用户不会每次都重装扩展；旧面板只修好了倍率显示，
// 提交时仍沿用 layerBounds。服务端在计费之前，是唯一还能拦住这次错误的地方。
// 反过来，范围本身站得住（盖住了不透明区）就原样保留——不要因为「可能是错的」而
// 把几何真值换成逐像素反推，那对半透明描边更不友好。
function rectifyExpandBounds(bounds, scales, canvas, opaque) {
  const usable = (rect) => {
    const checked = saneBounds(rect, canvas);
    return checked && photoLikeBounds(checked, opaque) ? checked : null;
  };
  const given = usable(bounds);
  if (given) return given;
  return usable(innerRectFromScales(scales, canvas)) || usable(opaque) || bounds;
}

// 给「只支持固定档位尺寸」的接口选一个最接近的档位。
// 权衡的是面积利用率与宽高比失真：先过滤掉宽高比偏差超过 35% 的档位，
// 剩下按像素面积最接近的挑；全部不合格时退化为纯面积最接近。
function snapToAllowedSize(width, height, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  const targetRatio = width / height;
  const targetPixels = width * height;
  let best = null;
  for (const item of allowed) {
    const [w, h] = String(item).split(/[x*×]/i).map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const ratioError = Math.abs(Math.log((w / h) / targetRatio));
    const pixelError = Math.abs(Math.log((w * h) / targetPixels));
    const score = pixelError + ratioError * 2;
    if (!best || score < best.score) best = { width: w, height: h, score, ratioError };
  }
  return best ? { width: best.width, height: best.height } : null;
}

module.exports = { composeExpand, encodeApiImage, expandStrips, extensionFidelity, detailEnergy, saneBounds, photoLikeBounds, deriveScales, innerRectFromScales, rectifyExpandBounds, harmonizeStrip, snapToAllowedSize };
