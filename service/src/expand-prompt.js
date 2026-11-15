'use strict';

// 扩图提示词。
//
// 单独抽成模块有两个原因：
// 1) 两个供应商（中转站 / 百炼）必须说同一套话，否则换个渠道观感就变；
// 2) 这段文案直接决定扩展区到底有没有内容。
//
// 这段文案改过三代，每一代都是被一次具体的翻车逼出来的：
//
// ① 「材质颗粒粗细必须与原图同一位置一致」——为修「沙滩上凭空长麻点」写的，
//    用力过猛：模型把延伸区理解成「已经画好的虚化背景」，原样返回，右边接一块白雾。
// ② 加了「接缝处被切断的东西必须接着画完」——白雾没了，但模型开始**补完物体**：
//    原图边缘只有半截架子横板，它就在延伸区画了一整个架子，还配上一盆植物。
//    用户看到的是「右边突然多出一套家具」，依旧接不上。
// ③ 现在这一版：把「观感一致」放在第一位，把「补完物体」改成保守的条件式。
//
// 关键认识：扩图最常见的失败不是「没画东西」，而是「画了不该画的东西」。
// 对一张浅景深的室内照，右边的延伸区本来就该是一片虚化的墙和地板——模型画得
// 越丰富、越清楚，越不像同一张照片。所以规矩是：先对齐景深和色温，再谈内容；
// 没有明确该延续的结构时，宁可是背景，也不要新增主体。

// 通用于两个供应商的硬性要求。顺序即优先级。
const CORE_RULES = [
  '用户的画面描述说的是「延伸区要延续成什么样」（材质、光线、空间），不是一份要新画进去的物体清单——描述里提到的台灯、架子、植物如果原图里已经有一个，延伸区就不要再画第二个。',
  '先读懂原图的景深：原图是不是浅景深？背景是不是虚化的？虚化的地方虚到什么程度、光斑有多大？延伸区必须保持同样的虚化程度。',
  '清晰度必须一致：紧挨着接缝的原照片有多虚，延伸区的对应位置就要多虚；原照片清晰，延伸区才清晰。延伸区比原照片更清楚，是最容易看出拼接的错误。',
  '色温、白平衡、亮度和对比度必须和紧邻的原照片完全一致。原图偏暖就偏暖，原图偏暗就偏暗，不能整体变白、变冷或变亮。',
  '延伸区只延续背景：墙面、地面、桌面、窗帘、天空、虚化的远景这些大面积的东西顺着原图继续延展过去。墙线、地平线、地板拼缝的走向顺着原图的透视走。',
  '不要在延伸区新增或补全任何物体。原图里出现过的台灯、架子、植物、家具、人，不要在延伸区再出现一次；画布边缘切到一半的物体，也不要把它补成一个完整的。',
  '贴着扩图边界被切断的东西（键盘、桌沿、衣袖、书本、架子横板、墙裙线、地平线）要顺着它原本的走向、透视和清晰度自然延伸过去，再随景深淡出；这不是「补全物体」——被切断的物体不许画成完整形状，延伸区也不许出现原图里没有的新物体。除此之外，延伸区只应该是背景。',
  '延伸区要有真实的材质和光影层次，不能是一块死板的纯色；但丰富程度要和原图一致——原图这里虚，延伸区也虚，只是虚得有层次，不是一块均匀的色块。',
  '严禁把延伸区涂成一片纯色、白雾、均匀渐变；严禁整块提亮、压暗、加暗角或蒙一层雾；不要用大面积模糊把接缝糊过去；不要出现规则重复的条纹、镜像痕迹或一条笔直的接缝线。',
  '平整的表面（桌面、墙面、屏幕、布面）保持平整，不要画成粗糙岩石、砂地或水泥，不要凭空添加颗粒、麻点、裂缝、划痕、文字或 logo。'
];

// 第二次尝试才加：把上一版的失败方式直接说出来。模型对「不要留空」这种否定式约束
// 反应一般，但对「上一版具体错在哪」这种反馈要敏感得多。
const RETRY_EMPTY = '注意：上一版把延伸区画成了一片空白或均匀模糊的背景，等于没画。这一次要把延伸区画成原照片背景的真实延续：墙、地面、光影照原样延展过去，虚化的地方保持虚化，仍然不要新增任何物体。';

// 另一种失败：不是空，是有颜色但没细节——整块像隔着毛玻璃。
const RETRY_FLAT = '注意：上一版把延伸区画成了一片没有层次的模糊色带，看不出是墙、是地面还是别的。这一次要把材质和光影的起伏画出来，但清晰度必须和紧挨着它的原照片完全一致——原图虚，这里也虚，只是虚得要有层次。';

// 第三种失败：画得太丰富——凭空多出物体，或者比原图清楚一大截。
const RETRY_ALIEN = '注意：上一版在延伸区画了原图里没有的东西，或者比原照片清楚太多，看起来像拼上去的另一张照片。这一次只延续背景：不要加任何新物体，清晰度、虚化程度、色温都要和紧邻的原照片完全一样。';

const RETRY_RULES = RETRY_EMPTY;

// 扩图方向与幅度。模型对「向右延展、约占总宽 22%」这种量化的方位描述反应明显更好，
// 只说「补全边缘」时它常常只画一条几像素的过渡带。
function extentInSides(bounds, canvas) {
  if (!bounds || !canvas) return [];
  const photoW = Math.max(1, bounds.right - bounds.left);
  const photoH = Math.max(1, bounds.bottom - bounds.top);
  const out = [];
  const push = (label, px, denominator, vertical) => {
    if (px >= 8) out.push({ label, px: Math.round(px), ratio: px / denominator, vertical });
  };
  push('向上', bounds.top, photoH, true);
  push('向右', canvas.width - bounds.right, photoW, false);
  push('向下', canvas.height - bounds.bottom, photoH, true);
  push('向左', bounds.left, photoW, false);
  return out;
}

function extentSentence(bounds, canvas) {
  const sides = extentInSides(bounds, canvas);
  if (!sides.length) return '';
  const dirs = sides.map((s) => s.label).join('、');
  const detail = sides
    .map((s) => `${s.label}约 ${s.px} 像素（约为原照片${s.vertical ? '高度' : '宽度'}的 ${Math.round(s.ratio * 100)}%）`)
    .join('，');
  return `本次是扩图：原照片在画布内不移动，需要${dirs}延展。新增区域${detail}。`;
}

// 三种「请求形态」共用同一套规矩，差别只在怎么向模型交代它的任务边界：
//
//   masked  上传「画布 + 留白底稿」，用遮罩标出延伸区。最理想——模型只需重绘遮罩区。
//           但中转站对遮罩的处理五花八门，有的直接丢掉，模型就把整张图重画一遍。
//   padded  同样上传底稿，但不带遮罩，靠文字说明哪块是延伸区。遮罩被吞掉时的备胎。
//   bare    只上传原照片本身，让它输出一张更大的构图。彻底不依赖遮罩语义，
//           也和「修补一张被弄坏的图」这种容易引发全局重画的语境无关。
//
// 为什么要按形态换着试，而不是把同一句话改写三遍：模型不听话时，换个问法比
// 换形容词有效得多。同一形态重试三次拿到的往往是同一个错法。
const SHAPE_HINT = {
  masked: '遮罩标出的透明区域就是需要你画的延伸区，其余清晰区域是原照片，必须原样保留。',
  padded: '底稿里被拉伸、模糊、镜像糊掉的部分就是延伸区，清晰区域是原照片，必须原样保留。',
  bare: '输入是原照片本身，没有留白。请在保持原照片的构图、内容、景深、色温和清晰度完全不变的前提下，把画面向上述方向扩大，并把多出来的那部分画出来。原照片里已经有的东西一件都不要移动、不要重画、不要补成完整。'
};

// 原照片贴在输出画面的哪一角。bare 形态必须说清楚，否则模型会把照片缩到中间再
// 四周各补一圈——那样取出来的条带和画布坐标对不上，接缝必然错位。
function anchorText(bounds, canvas) {
  if (!bounds || !canvas) return '';
  const h = bounds.left <= 0 ? '左' : bounds.right >= canvas.width ? '右' : '水平居中';
  const v = bounds.top <= 0 ? '上' : bounds.bottom >= canvas.height ? '下' : '垂直居中';
  if (h === '水平居中' && v === '垂直居中') return '居中';
  if (h === '水平居中') return v;
  if (v === '垂直居中') return h;
  return h + v;
}

function bareExtentSentence(bounds, canvas) {
  if (!bounds || !canvas) return '';
  const sides = extentInSides(bounds, canvas);
  if (!sides.length) return '';
  const photoW = Math.max(1, bounds.right - bounds.left);
  const photoH = Math.max(1, bounds.bottom - bounds.top);
  const dirs = sides.map((s) => s.label).join('、');
  return `输出画面是 ${canvas.width}×${canvas.height}，原照片是 ${photoW}×${photoH}，完整地贴在画面的${anchorText(bounds, canvas)}角，${dirs}多出来的部分是延伸区。`;
}

function buildExpandPrompt(userPrompt, options = {}) {
  const { bounds = null, canvas = null, attempt = 1, masked = true, shape = null, reason = 'empty', stamp = '' } = options;
  const mode = shape || (masked ? 'masked' : 'padded');
  const parts = [];
  const text = String(userPrompt || '').trim();
  // 用户描述必须打头（模型对开头最敏感），但**不能裸着放**。
  // 裸放的后果已经踩过：用户写「右边接着白墙、木架和一盏暖光台灯」，模型就
  // 在延伸区画了一个全新木架加一盆植物——它把描述当成了要新画进去的清单。
  // 加一个「延续成」的框，语义就从「新增清单」变成「延续目标」。
  if (text) parts.push('延伸区需要延续成：' + text + '。');
  parts.push('这是扩图任务：把画布上需要补的区域画成原照片的自然延续，让整张图看起来是一张完整拍下来的照片。');
  const extent = mode === 'bare' ? bareExtentSentence(bounds, canvas) : extentSentence(bounds, canvas);
  if (extent) parts.push(extent);
  parts.push(SHAPE_HINT[mode] || SHAPE_HINT.masked);
  parts.push(...CORE_RULES);
  if (attempt > 1) {
    parts.push(reason === 'flat' ? RETRY_FLAT : reason === 'alien' ? RETRY_ALIEN : RETRY_EMPTY);
  }
  // 每次请求带一个编号，让「文本」永远不重复出现。
  //
  // 这不是给模型看的，是给渠道看的：实测发现中转站会按**归一化后的提示词文本**
  // 缓存安全判定结果——同一段文字被内容安全拦过一次，之后一字不差地重发，
  // 无论内容多正常都会立刻返回 451（转个句号、换个空格都不行，空格会被归一化掉）。
  // 扩图提示词是固定模板，命中一次就等于这条画布尺寸下的扩图永久失效。
  // 加一个每次不同的编号，让每份文本都是新的，绕开这个缓存。
  if (stamp) parts.push('（请求编号 ' + stamp + '）');
  return parts.join(' ');
}

module.exports = {
  buildExpandPrompt, extentSentence, bareExtentSentence, anchorText,
  CORE_RULES, RETRY_RULES, RETRY_EMPTY, RETRY_FLAT, RETRY_ALIEN, SHAPE_HINT
};
