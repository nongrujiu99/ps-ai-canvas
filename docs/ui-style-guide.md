# AI 图像工坊 · UI 基准规范（Design Baseline）

> **地位：强制。** 本文件是面板视觉与布局的唯一基准。任何新增功能、重构、样式调整，
> 都必须先读本文件，按既有 token、组件与信息架构实现，**不允许**另起一套风格。
>
> **事实来源优先级**：`hosts/shared/panel.css`（可运行代码）> 本文件（规范描述）> 其它文档。
> 若两者不一致，以 `panel.css` 为准，并同步修正本文件——不要反过来「按文档改代码」。
>
> 建立时间：2026-11-12 · 对应 `panel.css` 版本：视觉系统重写后（暗房仪器）

---

## 0. 三条不可协商的铁律

1. **只有一种彩色。** 全界面除琥珀强调色与三个语义色（成功/警告/错误）外，不得引入任何其它色相。
   琥珀是暗房安全灯的颜色——暖，但不影响对画面冷暖和中性灰的判断。这个面板是给修图的人盯的，
   底色偏蓝会让人把照片看冷。**多一种颜色，就少一分专业感。**
2. **层次靠灰阶和 1px 细线，不靠阴影和卡片堆叠。** 全站只允许两种阴影：
   焦点光晕 `0 0 0 3px var(--accent-veil)`、指示灯光晕 `0 0 0 3px rgba(...,.16)`。
   没有投影、没有浮层阴影、没有渐变卡片。
3. **所有数字等宽（`tabular-nums`）。** 尺寸、秒数、倍率、序号在刷新时不能左右跳动。

---

## 1. Design Tokens

**唯一来源**：`hosts/shared/panel.css` 的 `:root`（深色，默认）与 `:root[data-theme="light|ps"]` 两个覆盖块。
新增样式必须 `var()` 引用这些变量，**不得写字面色值**。

### 1.1 色板（深色，默认）

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#161617` | 面板底色、设置页底色、滚动条轨道 |
| `--surface` | `#1c1c1e` | 输入框、卡片、预览容器底 |
| `--surface-2` | `#222224` | 分段控件容器底、icon 悬停底、scale-grid 底 |
| `--surface-3` | `#2a2a2d` | 选中态（分段当前项）、次要按钮、卡片操作条 |
| `--line` | `#303033` | 正常分隔线、卡片描边 |
| `--line-strong` | `#3d3d41` | 输入框描边、次要按钮描边、刻度轨道 |
| `--text` | `#eae7e2` | 正文 |
| `--text-bright` | `#fffdf9` | 标题、选中项文字 |
| `--text-dim` | `#a9a49b` | 次要文字、未选中控件、字段标签 |
| `--text-mute` | `#8b867c` | 提示、副标、占位符、说明 |
| `--accent` | `#e9a33f` | **唯一强调色**：主按钮、焦点边框、选中指示条、滑杆 thumb、复选框勾选 |
| `--accent-hover` | `#f5b558` | 主按钮悬停 |
| `--accent-text` | `#1a1205` | 琥珀底上的文字（深色） |
| `--accent-veil` | `rgba(233,163,63,.14)` | 焦点 3px 光晕 |
| `--focus-line` | `rgba(255,253,249,.42)` | **焦点线**（无边框控件用 inset 阴影画）。中性色，不是琥珀——原因见第 8 节 |
| `--ok` | `#8fbf6a` | 成功状态 + 指示灯 |
| `--warn` | `#e0b25a` | 警告状态 + 指示灯 |
| `--err` | `#e8735e` | 错误状态 + 指示灯 |
| `--preview-bg` | `#0e0e0f` | 图片显示底（比面板更黑，让画面本身跳出来） |

### 1.2 主题切换（三套 token · 四种模式）

`<html data-theme>` 由 `hosts/shared/theme.js` 写入（两端各存一份副本，`panel-parity` 逐字节比对）：

| 模式 | 运行时状态 | 说明 |
|---|---|---|
| **自动** | 解析成深色 / 浅色 | 读 `matchMedia('(prefers-color-scheme:light)')`；没有这个 API（老 CEP）就退回深色 |
| **深色** | 不写 `data-theme` | `:root` 的默认值。脚本没跑起来也是完整一套，不会出现半套变量 |
| **浅色** | `data-theme="light"` | 琥珀压深到 `#a8630a`，`--accent-text` 翻成 `#fff8ee`，焦点线 34% 黑 |
| **PS 灰** | `data-theme="ps"` | 底色取 Photoshop 面板的 `#424242`，中性灰、不偏暖，与宿主并排看不出拼接 |

入口只有一个：设置页「外观」分组里的四段分段控件（`data-count="4"`）。
选择存在 `localStorage['studio-ai-image.theme']`，读写都包在 try 里——UXP 旧运行时不支持时退化成「本次会话有效」。

**为什么不用 `@media (prefers-color-scheme)`**：那样用户改不了，而且「PS 灰」这类自定义主题根本表达不出来。
自动模式的解析交给 JS，CSS 只认一个显式属性，也就少一个只在特定系统上才走到的分支。

**新增组件不需要写主题分支**——只要用 token，自动跟随。

#### PS 灰的取值

| Token | 深色 | PS 灰 | 理由 |
|---|---|---|---|
| `--bg` | `#161617` | `#424242` | 直接取 PS 面板色，面板嵌进 PS 后看不出边界 |
| `--surface` | `#1c1c1e` | `#4b4b4b` | 灰阶一律**上调**：组件都假设 surface 比 bg 亮一档；反过来的话输入框会陷进面板，层次全翻 |
| `--surface-2` | `#222224` | `#525252` | 同上 |
| `--surface-3` | `#2a2a2d` | `#5c5c5c` | 选中项必须比容器亮，否则「当前项」读不出来 |
| `--line` / `--line-strong` | `#303033` / `#3d3d41` | `#555555` / `#6a6a6a` | 中间灰上的细线对比余量小，要拉大一档才看得见 |
| `--text` / `--text-dim` | `#eae7e2` / `#a9a49b` | `#e4e4e4` / `#b0b0b0` | 去掉暖调；`--text-dim` 提亮，因为 #424242 上原值对比不足 |
| `--accent` | `#e9a33f` | 同 | 琥珀在 #424242 上约 5.6:1，够用。**强调色不随主题变**，换了就不再是这个面板 |
| `--ok/--warn/--err` | 深色值 | 各提亮一档 | 同一组深绿/深黄/深红在浅一层的灰上会发闷 |
| `--preview-bg` | `#0e0e0f` | `#2e2e2e` | 仍要比面板暗，图片才跳出来 |
| `--focus-line` | `rgba(255,253,249,.42)` | `rgba(255,255,255,.45)` | 中间灰上要更亮一点才看得清 |

**新增一套主题必须给全 token**：`ui-guard` 会比对三套主题的 token 集合是否完全相等，
少一个不会报错，只会「某个控件在新主题下还是旧主题的颜色」——最难查的一类问题。

### 1.3 允许的派生色（豁免清单）

以下 rgba 是**唯一**允许出现的字面色值，因为它们都是透明叠加，无法用 token 表达：

- 指示灯光晕：`rgba(126,121,111,.14)` / `rgba(143,191,106,.16)` / `rgba(224,178,90,.16)` / `rgba(232,115,94,.16)`
- 锁定徽章：`rgba(232,115,94,.1)` 底 + `rgba(232,115,94,.38)` 边
- 预览序号角标：`rgba(0,0,0,.55)` 底 + `#fff` 字（图上叠加，必须与图上内容解耦）
- 对比视图的「原图 / 生成后」角标、卡片右上角的放大键：同上（`rgba(0,0,0,.55)` 底 + `#fff`，压在图上）
- 占位扫描线：`rgba(233,163,63,0 → .18 → 0)`

**除这四类之外，出现任何 rgb/hex 字面值都视为违规。**

---

## 2. 字体

```
font-family:"Segoe UI","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
```

- 基准：`font-size:13px; line-height:1.45`
- **字重只有 400 / 600 两档。** 没有 500，没有 700，没有 300。
- 字距只在三处使用：标题 `.01em`/`.02em`、字段标签 `.03~.06em`、按钮 `.03em`/`.04em`。

### 2.1 字号阶梯（用满为止，不得新增）

| 字号 | 字重 | 用途 |
|---|---|---|
| 14 | 600 | 面板标题 `h1`、设置页标题 `h2` |
| 13 | 400 | 正文基准、`textarea`、设置页普通输入 |
| 12.5 | 400/600 | 模式按钮、设置页 `input/select` |
| 12 | 400 | 高级选项表格行、表格内控件、`seg`、设置页操作按钮 |
| 11.5 | 400 | 渠道信号行、折叠条 `summary`、状态行、说明 `note`、预览卡按钮、占位标签 |
| 11 | 400/600 | 字段标签（600）、`hint-chip`、分组标题 `h3`（600,`.06em`）、`mini` 按钮、`hint`、文档副标 |
| 10 | 600 | 卡片序号角标（`.08em`）、锁定徽章 |

**反例**：主面板正文用 12px 以下是错的（太密），用 15px 以上也是错的（面板只有 280~520px 宽，字大了信息密度就崩）。

---

## 3. 间距 · 圆角 · 边框 · 动效

### 3.1 间距（允许值集合，不在此列的一律改写）

`2 3 4 5 6 7 8 9 10 11 12 14 16 22`

- 面板内边距：`14px 14px 22px`，`max-width:520px`，居中
- 块与块：`12px`（紧凑）/ `14px`（标准）/ `16px`（分组/结果区）
- 组内元素：`7px`（标签到控件）/ `8~11px`（按钮内边距）
- **不用 13 / 15 / 17 / 18 / 20 这类数字。**

### 3.2 圆角阶梯

| 半径 | 用途 |
|---|---|
| 0 | **重置**：信号行、分段项、折叠条这类「不是卡片」的控件，明确写 0 而不是省略 |
| 1px | 2px 高的状态指示条（`.status::before`） |
| 2px | 3px 高的滑杆轨道 |
| 3px | 倍率十字中央的虚线原图框 |
| 4px | 序号角标、锁定徽章、复选框 |
| 5px | 小型输入（倍率框、高级选项控件） |
| 6px | icon 按钮、`mini` 文字按钮 |
| 7px | 分段项（`mode` / `seg`）、设置页输入框 |
| 8px | `textarea`、主/次/静音按钮 |
| 9px | 预览卡、分段容器、预览占位 |
| 10px | `scale-grid`（画布框） |
| 50% | 品牌光环、指示灯、滑杆 thumb |

> 前三档是「微元素」半径，只用于高度 ≤ 4px 的细条或线框。`ui-guard.test.js` 只放行这一张表里的值。

### 3.3 边框

- 一律 `1px solid`，颜色只用 `--line` 或 `--line-strong`。
- **禁止 2px 边框。** 焦点用 `outline` 或 3px 光晕表达，不靠加粗边框。
- 分隔优先用 `border-top`（横向区块），组内行用 `border-bottom`，行末 `:last-child` 去掉。

### 3.4 动效

- 颜色/背景/边框/微位移过渡：`.12s`。**上限 .2s**，再慢就显得面板卡。
- 只允许两个 `@keyframes`：`ph-sweep`（扫描线 2.4s linear）、`ph-spin`（转圈 .9s linear）。
- 末尾必须有 `@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`。

---

## 4. 组件规格

复制 `docs/ui-template/skeleton.html` 里的结构，不要重写。每个组件都是「DOM 骨架 + 已有 class」，
新增功能只需往里填内容。

| 组件 | 结构要点 | 硬约束 |
|---|---|---|
| **页头 `.top`** | `.brand`（`.mark` 光环 + `.brand-text`：`h1` + `.document` 副标）+ 右侧 `.icon` 按钮 | 标题 14px，文档状态 11px 灰字，`text-overflow:ellipsis`。**不要**再引入 eyebrow 小字英文行或独立信息框 |
| **渠道信号行 `.provider`** | `.provider-label`（固定类别）+ `.provider-chip`（会变的半截，胶囊）+ `.provider-go`，只有 **上方**一条 1px 线 | 它是**状态**，不是输入框：无外框、无背景、圆角 0。状态 class：`.ok` / `.warn` / `.error` **只改胶囊的描边与字色**——不再单独放指示灯（两处同时变色＝重复表达）。整行是一个 `<button>`，胶囊是它的 `<span>`，**禁止**内部再套 `<button>`（嵌套按钮点击失效）。下方不画线，交给模式框自己的边框 |
| **分段控件 `.modes` / `.segmented`** | 3 等分（模式）/ 3 等分（设置页渠道，`data-count="3"`）；四段用 `data-count="4"`（外观）。三段和四段每格字号 11.5px、左右内边距 2px，`grid-gap:2px`，容器 `--surface-2` | 当前项 `--surface-3` 底 + `box-shadow:inset 0 -2px 0 0 var(--accent)`。**用 inset 阴影画指示条**，不加元素、不做定位 |
| **字段 `.field-head` + `textarea`** | 左 label 11px/600，右 `.hint-chip` 11px 灰 | textarea 最小高 82px，`resize:vertical`，焦点=琥珀边框 + 3px 光晕 |
| **倍率十字 `.scale-grid`** | 3×3 网格，四个 `label` 落在四条边，中央 `::before` 虚线框代表原图 | 方向即位置，**不要**再写「上/右/下/左」排一行。数字框固定 48px 宽，隐藏 spinner。**四个方向一律实线框**，可编辑与只读（`.derived`）框体完全相同，只读只靠数字颜色（`--text-dim`）+ `readOnly` + 上方 note 说明来区分。不许去边框（框会消失成一串裸数字），也不许改虚线（会和中央的原图框混成同一种语义） |
| **折叠区 `details`** | `summary` + `::after` 的 `+` / `−` | 用 `+`/`−` 而不是 `▸`/`▾`（字体缺字会变方块）。折叠条本身是一条 `border-top`，不是卡片 |
| **参数行 `.param-row`** | flex 一行 2~3 项，每项 `label`：标签 11px/600 在上、控件整宽在下；`label.wide` 给需要更多宽度的（输出尺寸 `flex-grow:1.6`） | **每次都要看的短参数**放这里（候选数量 / 随机种子 / 输出尺寸），常显不折叠。用 flex 不用 grid：强绑条件的项一隐藏，剩下几项自动均分，不留空格子。间距用子项 `margin-right` + 容器负边距（`gap` 在 CEP 61 无效） |
| **高级选项表 `.advanced-fields`** | 每行 `label`：名称靠左、控件靠右（宽 112px）、行间 1px 线 | 只放**有强绑条件的开关**（整张画面重绘、修改幅度、额外请求确认）；一项都不可见时整块 `details` 由 JS 收起，不留空壳 |
| **主操作 `.primary`** | 琥珀实心，`--accent-text` 字，圆角 8，`padding 11px 12px` | 一个视图内**只允许一个** `.primary`。生成中的「停止」降级为 `.quiet` 窄按钮靠右（补救动作不与主动作平分视线） |
| **状态行 `.status`** | `role="status"`，`:not(:empty)` 时左侧 2px 指示条 | 语义 class：`.ok` / `.warn` / `.error` 同时改文字色与指示条色。空内容时不留孤线 |
| **结果卡 `.previews` / `.preview`** | 容器 `data-count` 控制列数（1 列 / 2 列），图 `object-fit:contain`，左上 `.idx` 角标，右上 `.preview-zoom` 放大键，底部整宽按钮 | 卡片**复用不重建**；图按真实比例显示，不裁切；悬停按钮变琥珀。**图本身就是入口**（`cursor:zoom-in`，点开预览层）；放大键只是给「看不出图能点」的人留的第二入口，不能替代点图 |
| **结果预览 `.viewer` / `.compare`** | 覆盖层，头部复用 `.settings-head`（标题 + 右侧 `.viewer-tools`：`.mini` 切换 + 关闭 `.icon`）。有原图时是 `.compare`：`.compare-before` 在文档流里定容器大小，`.compare-reveal` 按 `--cmp-x` 裁切，里面 `.compare-after` 宽度取 `--cmp-w`；竖线 `.compare-handle` + 两个角标；下方 `.compare-bar` 里一条 `.compare-range` + `.hint` | 两层图**必须严格同宽**：`--cmp-w` 由 `compare-view.js` 写成像素值（百分比会被裁切框压扁，`clip-path` 在 UXP 上不保证支持）。没有原图（纯生成）时**不画滑块**，退化成 `.viewer-photo` 单图并说明原因。Esc 关闭、方向键每次 2%；关闭时摘掉 `src` 释放内存 |
| **生成占位 `.preview-placeholder`** | `.ph-ring` 转圈 + `.ph-label` + `.ph-note` + 扫描线 | 占位高度固定 190px，避免出现结果时面板跳动 |
| **设置页 `.settings`** | `position:fixed` + `top/right/bottom/left:0` 铺满，`.settings-head` + 若干 `.group` | **禁用 `inset:0`**（Chromium 87+）。三组：生成渠道（用户真实目的在前）、本地服务（平时不用管）、外观（最后，改一次就不再动）。第三方表单最后一个字段是「显示名称 · 可留空」，它**同时覆盖两处文字**：顶部分段按钮 `#channel-openai-tab` 与顶部渠道行 `.provider-label`，两处读同一个 `channelName()`，留空一起回落「第三方 API」。固定类别（OpenAI 兼容协议）收进按钮 `title`，改名后仍看得出是哪条通道；分段按钮对长名字 `text-overflow:ellipsis`，不允许撑破 `.segmented` |
| **按钮族** | `.primary` 琥珀实心 · `.secondary` `--surface-3` 底 + 描边 · `.quiet` 透明 + 描边 · `.mini` 11px 窄按钮 · `.icon` 28×28 纯图标 | 圆角：前三者 8px，`.mini`/`.icon` 6px。悬停：primary 转 `--accent-hover`；secondary/quiet/mini 改琥珀描边 + 琥珀字；icon 变 `--surface-2` 底。禁用：primary 转 `--surface-3` + mute 字且**不响应悬停**，secondary/quiet `opacity:.4` |
| **图标** | `<svg>` 15×15，`fill:none;stroke:currentColor;stroke-width:1.5` | 不引第三方图标库。纯图标按钮必须有 `aria-label`，装饰图形加 `aria-hidden` |
| **锁徽章 `.lock`** | 10px/600，err 字 + `rgba(232,115,94,.1)` 底 + `rgba(232,115,94,.38)` 边，圆角 4 | 只表达「当前不可改」这一种语义。不用它做普通提示 |
| **设置分组 `.group` / `.group-head`** | `border-top` 分隔，`h3` 11px/600；`.settings-head + .group` 是首组，去线 | 一页最多三组；`.hint` 放组末尾 |
| **双列操作 `.channel-actions`** | `grid-template-columns:1fr 1fr;grid-gap:8px` | 只放「保存 + 测试」这类并列动作，不塞第三个 |
| **`.hint`** | 11px，`--text-mute`，行高 1.55 | 说明性小字，写法见 5.3 文案规范 |
| **`.hidden`** | `display:none!important` | **唯一**的显示切换手段。不用 `visibility`/`opacity`/`height:0` 代替 |

---

## 5. 信息架构（主面板顺序固定）

```
页头（标记 + 标题 + 文档状态 + 设置）
渠道信号行（连的是谁 + 状态灯）
模式分段（选区编辑 / 扩图 / 生成）
工作区
  ├ 画面描述（label + hint-chip + textarea）
  ├ 模式专属区（如扩图的倍率十字；仅当前模式可见）
  ├ 参数行（候选数量 / 随机种子 / 输出尺寸，常显一行；输出尺寸仅生成模式可见）
  ├ 更多选项（details 折叠，只有条件项在里面；无可见项时整块收起）
  ├ 主操作行（primary + 可选 quiet）
  └ 状态行
结果区（候选卡 / 生成占位）
设置页（覆盖层，返回后可回主面板）
```

**顺序不可调整。** 用户从上到下的视线路径是「我在哪 → 连的什么 → 要做什么 → 写什么 → 点哪个 → 结果如何」。

### 5.1 视图层级 · 新增或改造一个界面时

面板只有两层视图，**没有路由、没有第三个平级页**：

1. **主面板** — `.panel` 内 `.top` → `.provider` → `.modes` → `.work` → `.previews`
2. **覆盖层** — `.settings`（设置）与 `.viewer`（结果预览），`position:fixed` 铺满，同一时间只允许一层

**新增整页视图的规则**

- 必须是**覆盖层**，复用 `.settings` 的定位方式：`position:fixed` + 四边 `0` + `--bg` 底 + `z-index:2`。
  **不要**侧滑抽屉、居中弹窗、多栏分屏。
- 入口只有一个：页头右上 `.icon`，或设置页内的一个入口。**不要**在主面板底部再加「更多」。
  （唯一例外：结果预览的入口在结果卡上——它是「看这张图」的直接动作，把人赶去页头再找一遍是反直觉的。）
- 覆盖层必须有 `.settings-head`（标题 + 返回 `.icon`），返回后主面板保持原状态（不重建 DOM）。
- 同一时间只允许一层覆盖层。「设置 → 子页面」靠返回按钮逐层退，不叠罗汉。

**改造主面板结构的判定**

| 改动 | 性质 | 必须同步什么 |
|---|---|---|
| 调换区块顺序、增删区块 | **结构变更** | 先改本文件第 5 节 + `skeleton.html`，再改 `index.html` |
| 区块内换内容、调文案 | 局部调整 | 改完同步第 4 节组件表（如涉及） |
| 只改颜色/字号/间距 | 视觉调整 | 只改 `panel.css` + 同步本文件 token 或阶梯表 |

**没有媒体查询断点。** 布局靠 flex / grid 自适应，最小可用宽度 **280px**（`body{min-width:280px}`）。
不写 `@media (max-width:…)` 分支——PS 面板宽度由用户拖动，任何固定断点都会在某个宽度上突然跳变。

### 5.2 由 JS 控制的 class（不要用内联样式换外观）

| class | 谁加 | 含义 |
|---|---|---|
| `.hidden` | 任意 | 隐藏（`display:none!important`），唯一的显示切换手段 |
| `.active` | `.modes` / `.segmented` | 当前选中项 |
| `.ok` / `.warn` / `.error` | `.provider` 信号行 | 胶囊三态（只改 `.provider-chip` 的描边、字色与淡底） |
| `.ok` / `.warn` / `.error` | `.status` 状态行 | 文字色 + 左侧 2px 指示条 |
| `.legacy-focus` | `main.js` | 老 CEP 不支持 `:focus-visible` 的兜底，挂在 `<html>` 上 |
| `.pointer` | `main.js` | 最后一次输入是鼠标（`mousedown` 加 / `keydown` 摘）。只在 `.legacy-focus` 下起作用，用来撤掉鼠标点剩下的焦点线。**两端 `main.js` 各有一份实现，逻辑必须一致**（宿主事件系统不同，无法抽成共用模块） |

**禁止**在 JS 里写 `style.display` / `style.color` 之类切换外观——外观只有 CSS 一个出口，
JS 只负责加 class。唯一例外：必须由数据决定的几何量（如图片实际宽高比、对比滑块的裁切位置
`--cmp-x`、结果图与容器等宽的像素值 `--cmp-w`）。这类变量写进样式表当默认值，JS 只覆盖数值。

### 5.3 文案规范

- **说人话，不甩错误码。** 「选区里没有可编辑像素，请重新框选」，而不是 `INVALID_SELECTION`。
  错误码只留在日志和 `title` 属性里。
- **每句错误都要给出下一步。** 「…请重新框选」「…先启动本地服务」。给不出建议，就别写这句。
- **不用感叹号，不用「哎呀 / 抱歉 / 失败啦」。** 这是仪器面板，不是聊天窗口。
- **数字带单位。** 「约 20 秒」「2516 × 2560 像素」「1.5 倍」，不写裸数字。
- **耗时过一秒就换成秒。** 「TLS 3.3 秒」好过「TLS 3330ms」——后者要人在脑子里除一次。
- **`.hint` 只回答「我为什么该这么做」**，不解释实现。
  「API Key 存在系统凭据库，不写进配置文件」就是标准长度。
- **中文全角标点，中英之间留空格。** 「PNG 格式」「8 位」「RGB」。
- 扩图提示必须带「描述只写材质和光线，别列物体」——这是产品逻辑，不是文风问题。

### 5.4 状态语义（什么时候用哪个颜色）

| 状态 | 用在哪 | 判定 |
|---|---|---|
| 无 class（灰） | 信号行 / 状态行 | 进行中、中性信息：已提交任务、正在读取、等待操作 |
| `.ok` | 信号行 / 状态行 | 服务已连接、结果已就绪、配置已保存 |
| `.warn` | 信号行 / 状态行 | 能继续但有代价：尺寸与画布比例不符、渠道未经验证 |
| `.error` | 信号行 / 状态行 | 已失败，用户必须做点什么才能继续 |
| `.lock` 徽章 | 设置页分组标题旁 | 选项被配置文件锁定，当前不可改 |

同一行内**只允许一处**承载状态色。顶部渠道行就是范例：灰色类别文字 + 一枚按状态上色的胶囊，
而不是「指示灯变绿、正文也跟着变绿」。

**不要为了让界面「有颜色」而用语义色。** 一条普通进度提示用灰就够；
满屏 ok / warn 等于什么重点都没有。

### 5.5 两端 DOM 允许的差异（登记制）

CEP 与 UXP 共用一份 `panel.js` / `panel.css`，但**宿主能力不同**，DOM 允许极小差异。
目前只有两处，都必须在标记处写注释说明原因：

| id | 只在 | 原因 |
|---|---|---|
| `#start-service` | CEP | CEP 侧有 launcher 能拉起本地服务进程；UXP 侧没有这个模块 |
| `#cost-confirm` | UXP | UXP 用面板内复选框；CEP 用 `window.confirm()` 原生弹窗 |

**新增差异必须同时做三件事**：① HTML 里写注释说明原因 ② 在本表登记
③ 更新 `hosts/cep/test/ui-guard.test.js` 的 `HOST_DOM_DIFF` 清单。
没登记就分叉，`ui-guard` 会当场失败。

**除此之外，两端 DOM id 必须完全一致。** 历史上两端各自演化过（UXP 丢过推导比例和
临时文件回收，而且错得静默），这条要守住。

---

## 6. 新增功能时怎么放（决策树，按序判断）

1. **它是一个新的「做什么」吗？** → 加一个 `.mode` 分段项（三段以上改 `grid-template-columns`，但仍用同一套 `.mode`）。模式专属控件放 `.work` 内、模式分段之后，用 `.hidden` 切换。
2. **它是某个已有操作的参数吗？** → 先问「每次操作都要看一眼吗」：是 → 进 `.param-row`，标签在上控件在下；否（有强绑条件的开关）→ 进 `.advanced-fields`，名称在左控件在右，默认折叠。
3. **它是配置/凭据/服务状态吗？** → 进设置页对应 `.group`，不占用主面板首屏。
4. **它是操作结果吗？** → 进 `.previews` 卡片区，或复用 `.status` 写一句话。
5. **它是一个持续显示的状态？** → 复用 `.provider` 信号行的形态（指示灯 + 文字 + 箭头），不要新造一行灰字。
6. **以上都不是，且确实需要新组件？** → **先在 `hosts/shared/panel.css` 用既有 token 实现**，命名沿用现有词汇（`.preview`、`.provider`、`.status` 这类单个名词，不用 BEM `__`），并更新本规范第 4 节表格。

**禁止**：主面板上出现第二个 `.primary`；新增整宽说明段落占据首屏；为单个功能新增一种字体大小或圆角。

---

## 7. 兼容性红线（Chromium 61，PS 2021 以前）

CEP 在 PS 2018–2020 上是 **Chromium 61**。以下语法写了会**整条规则被静默丢弃**——界面只是「没生效」，很难查。

| 禁用 | 从哪个版本才有 | 正确写法 |
|---|---|---|
| `flex` 的 `gap` | 84+ | 用 `margin`，或改用 `display:grid` + `grid-gap` |
| `grid-gap` 写成 `gap` | 66+ 部分，统一写 `grid-gap` 更稳 | `grid-gap:6px` |
| `:has()` | 105+ | 由 JS 打 class |
| `:is()` / `:where()` | 88+ | 写完整选择器列表 |
| `clamp()` / `min()` / `max()` | 79+ | 固定值 + 媒体查询 |
| `conic-gradient` | 69+ | `linear-gradient` 或 `radial-gradient` |
| `accent-color` | 93+ | 自绘 checkbox（已实现） |
| `aspect-ratio` | 88+ | `min-height` / `max-height` + `object-fit` |
| `inset:0` | 87+ | 写 `top/right/bottom/left:0` |
| `:focus-visible` | 86+ | 可写，但必须同时提供 `.legacy-focus` 的 `:focus` 兜底（`main.js` 已探到不支持时给 `<html>` 加 class）；鼠标输入还要靠 `.pointer` 撒掉焦点线（见第 8 节） |

> 视觉上要新，语法上必须老。写之前问一句：这条规则在 Chromium 61 上会被丢吗？

---

## 8. 无障碍与焦点

焦点有**两套语义**，别混：

| 场景 | 实现 |
|---|---|
| 输入框（`textarea` / `input` / `select`） | `border-color:var(--accent)` + `box-shadow:0 0 0 3px var(--accent-veil)`，**同时写 `outline:0`** |
| 无边框控件（`button` / `summary` / `label`） | `outline:0` + `box-shadow:inset 0 0 0 1px var(--focus-line)` |
| 选中 + 焦点同时出现（`.mode.active`） | 两条 inset 叠加：`inset 0 0 0 1px var(--focus-line),inset 0 -2px 0 0 var(--accent)` |

### 为什么焦点不用 outline，也不用琥珀

两条都是踩过的坑：

1. **Chromium 61 的 `outline` 永远是直角**，套在圆角控件上像贴了张方纸；`outline-offset:2px`
   还会伸出容器边界。所以一律用 `box-shadow:inset`——它跟随圆角，且不占布局。
2. **琥珀要留给「主操作」和「选中」。** 焦点框如果也是琥珀，点一下模式按钮就会出现
   「外面一圈琥珀 + 里面一条琥珀指示条」，读起来像两层选中。焦点线用中性色 `--focus-line`
   （深色 42% 白 / 浅色 34% 黑），只表达「你在这」，不抢语义色。

### `.pointer` 机制（为什么需要它）

老 CEP 没有 `:focus-visible`，退回 `:focus` 后，鼠标点完焦点会一直留在控件上。`main.js`
记录最后一次输入设备：`mousedown` 给 `<html>` 加 `.pointer`，`keydown` 摘掉；
`.legacy-focus.pointer` 下撤掉焦点线。鼠标用户看不到多余的框，键盘用户照样知道自己停在哪。
现代宿主有 `:focus-visible`，这套不生效，也不需要。

**每条焦点规则都必须显式写 `outline:0`**：不写就轮到浏览器内置的 `1px auto` 白框
（实测 238 灰白），比琥珀框还显眼。

其它：

- 纯图标按钮必须有 `aria-label`；装饰性图形加 `aria-hidden="true"`。
- 状态区用 `role="status"`，结果区用 `aria-label`。
- 交互元素最小高度 28px（icon）/ 30px（seg）/ 32px（mode）。

---

## 9. 改动流程与文档联动

**规范不会自动跟着代码变，必须手动同步。** 每次改 UI 走完这五步：

```bash
# 1. 定性质：查 5.1 的表，是「结构变更 / 局部调整 / 视觉调整」
# 2. 改代码：只改唯一源 hosts/shared/panel.css（结构改 index.html）
# 3. 同步文档：按下面的联动表
# 4. 同步副本（CEP / UXP 打包结构不同，只能各放一份）
cp hosts/shared/panel.css hosts/cep/css/panel.css
cp hosts/shared/panel.css hosts/uxp/css/panel.css
# 5. 跑 parity + 面板逻辑测试
node --test hosts/cep/test/*.test.js hosts/uxp/test/*.test.js
```

### 9.1 改了什么 → 必须同步什么

| 你的改动 | 必须同步的文件 |
|---|---|
| 新增/修改/删除 token | 本文件 1.1 **和** 1.2（三套主题都要给值，`ui-guard` 会比对）+ `preview/ui-template.html` 色板（加 `data-token` 条目） |
| 新增字号 / 圆角 / 间距 | 本文件 2 / 3 的阶梯表 + `hosts/cep/test/ui-guard.test.js` 的白名单（**两处必须一致**，否则测试会挂）+ 一句「为什么现有阶梯不够」 |
| 新增或修改组件 | 本文件第 4 节组件表 + `docs/ui-template/skeleton.html` + 预览页加一个实例 |
| 增删渠道字段 | `service/src/channel-store.js`（存/校验）+ `hosts/shared/channel-view.js`（`apply` / `payload` / `CONTROLS`）+ 四份 HTML（cep / uxp / skeleton / live）+ `ui-guard` 的 id 并集断言 |
| 改主面板结构（顺序/增删区块） | 本文件第 5 节 + `skeleton.html` + `preview/live.html`（复用同一套面板 id；live 另有 `dk-*` 演示控件） |
| 新增一个覆盖层页面 | 本文件 5.1 + `skeleton.html` 增一段视图结构 |
| 改文案规则 | 本文件 5.3；只调文案不碰规则则无需改文档 |
| 改状态用色判定 | 本文件 5.4 |
| 新增/修改主题 | 本文件 1.2（四种模式 + 取值表）+ `hosts/shared/panel.css` 主题块 + `hosts/shared/theme.js` 的 `MODES`（**三处必须一致**）+ `ui-guard` 的 token 比对 |

### 9.2 三条纪律

- **绝不**直接改 `hosts/cep/css/panel.css` 或 `hosts/uxp/css/panel.css`——
  `panel-parity.test.js` 逐字节比对，不一致直接失败。
- **绝不**新建第二个 css 文件来「放新组件」。新组件进 `panel.css`，
  否则样式又开始各自演化（这正是 parity 测试存在的原因）。
- **规范与代码不一致时，以代码为准**，并在当次改动内补齐文档。
  「文档写着一套、面板长着另一套」比没有文档更糟。

### 9.3 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-11-12 | 首版：从 `panel.css` 提取全部 token、7 档字号、圆角/间距阶梯、19 个组件、信息架构、落位决策树、Chromium 61 红线 |
| v1.1 | 2026-11-12 | 补全组件表（按钮族/图标/锁徽章/分组/双列操作/hint/hidden）；新增 5.1 视图层级与结构变更判定、5.2 动态 class 约定、5.3 文案规范、5.4 状态语义；新增 9.1 文档联动表 |
| v1.2 | 2026-11-12 | 补 3.2 微元素半径（0/1px/2px/3px）；新增 `hosts/cep/test/ui-guard.test.js`，把语法红线、字号/圆角阶梯、token 完整性、模板 class 存在性变成会失败的断言 |
| v1.3 | 2026-11-12 | 新增 5.5 两端 DOM 差异登记制（`#start-service` CEP 独有、`#cost-confirm` UXP 独有）；骨架补齐 `#channel-openai` 整块与 `#test-status`；`ui-guard` 增 2 条 DOM 断言（两端差异必须等于登记表、骨架必须覆盖两端并集） |
| v1.4 | 2026-11-12 | **焦点样式重写**：不再用 `outline`（Chromium 61 下永远是直角），改用 `box-shadow:inset 0 0 0 1px var(--focus-line)`；新增 `--focus-line` token（深 42% 白 / 浅 34% 黑）与 `.pointer` 输入设备状态类；第 8 节整节重写并说明「为什么焦点不用琥珀」 |
| v1.5 | 2026-11-14 | **新增参数行 `.param-row`**：候选数量 / 随机种子 / 输出尺寸 从「更多选项」提到常显区，一行排开、标签在上；`.advanced-fields` 只留条件开关，无可见项时 JS 收起整块 `details`；`ui-guard` 新增结构断言（三参数必须在参数行、不得退回折叠区） |
| v1.11 | 2026-11-14 | **倍率框四向统一实线**：`.scale-grid.derived input` 只保留 `--text-dim` 字色 + `cursor:default`，不再改边框/底色——只读与可编辑框体完全一致，避免「虚线 = 另一种控件」的误读；`ui-guard` 断言改为「禁止去边框、禁止改 border-style」 |
| v1.10 | 2026-11-14 | **倍率框只读态保留框体**：`.scale-grid.derived input` 从「透明边框」改成「虚线边框 + `--text-dim` 字」；透明版在真实画布上等于把控件画没了（用户反馈「运行的时候怎么变样了」）。活文档 `preview/ui-template.html` 补一格 `.derived` 对照；`ui-guard` 加断言禁止再退回 `border-color:transparent` |
| v1.9 | 2026-11-14 | **显示名称同步**：`#channel-openai-tab` 的文案改由 JS 写入（`apply()` 里调 `syncTabName()`），跟顶部渠道行读同一个 `channelName()`；默认称呼收成一个常量 `DEFAULT_CHANNEL_NAME`，不再三处各写一遍字面量；`.seg` 加 `min-width:0` + `text-overflow:ellipsis`，24 字长名字不撑破 `.segmented` |
| v1.8 | 2026-11-14 | **渠道显示名称**：第三方表单新增 `#channel-name`（可留空，回落「第三方 API」），存进 `channel.json` 的 `openai.name`；`providerSummary` 的类别文字改读它，留空才用默认值——默认文案只在这一处回落，别在别处再写字面量 |
| v1.7 | 2026-11-14 | **渠道行重构**：`#provider-text` 一整句拆成 `.provider-label`（固定类别）+ `.provider-chip`（状态胶囊）；去掉独立指示灯与下方分隔线（40px 内曾出现三条横线）；`providerSummary` 返回 `label` / `detail` / `text`（`text` 给 tooltip）；`ui-guard` 增结构断言 |
| v1.6 | 2026-11-14 | **主题改为显式切换**：`@media(prefers-color-scheme)` → `<html data-theme>`，新增「PS 灰」主题（底色取 PS 面板 `#424242`，中性灰），设置页加「外观」分组（四段分段控件 `data-count="4"`）；新增 `hosts/shared/theme.js`（两端副本，`panel-parity` 覆盖）；`ui-guard` 改为比对三套主题 token 是否等长 |
| v1.12 | 2026-11-14 | **测试结果带建连分段**：探针慢于 800ms 时，`#test-status` 在总耗时后追加「建连 DNS · TCP · TLS」三段（≥1 秒写秒，如「TLS 3.3 秒」），并在一眼就慢时补一句「线路偏慢，出图会先卡在建连上」；服务端用 `node:https` 单独做一次握手计时（收到 `secureConnect` 立刻销毁，不发请求、不消耗配额）。理由：`latencyMs` 一个总数分不清「模型排队」和「本机线路慢」，而这决定了用户今晚该不该拿这条线出 4K 图 |
| v1.13 | 2026-11-14 | **结果预览 + 原图对比**：候选卡可点（`cursor:zoom-in`）或点右上 `.preview-zoom` 进入 `.viewer` 覆盖层；有底稿时用 `.compare` 两层叠放 + `.compare-handle` 竖线滑块（拖动 / `.compare-range` / 方向键 2% 三种入口），纯生成没有底稿就退化成 `.viewer-photo` 单图并说明原因。原图不再由面板自己抓：服务端提交任务时压一张 1400px 的 PNG 存在任务里，`GET /v1/jobs/:id/origin` 回给两端（UXP 的 capture 是裸 RGBA，前端没有 PNG 编码器，两端各写一套必然分叉）。新增共享模块 `hosts/shared/compare-view.js`（两端逐字节副本，`panel-parity` 覆盖）；5.2 的几何例外补上 `--cmp-x` / `--cmp-w` |
| v1.14 | 2026-11-14 | **渠道第三块：FLUX（Black Forest Labs）**：设置页分段从两段变三段（`data-count="3"`，`grid-template-columns:repeat(3,1fr)`，字号 11.5px、内边距 2px——两列网格放三个按钮时会掉到第二行）。FLUX 只暴露 4 个字段：API Key、文生图模型、显示名称、服务地址（留空用官方）；**没有「尺寸模式」**，因为它直接收 width/height 整数；扩图与选区编辑各走固定端点，不在这选模型，所以表单底部有一句 `.hint` 说明。`.channel-body .hint` 单独补下边距 10px——否则文字会贴到「保存」上（FLUX 那段正好长到换行，视觉上像被裁掉半边） |

> 改规范时在这里加一行。版本号不必严谨（v1.2 / v1.3 足够），**但要能看出改了什么**。

---

## 10. 交付前自检

- [ ] 没有新增字面色值（除 1.3 豁免清单）
- [ ] 没有新增字号 / 圆角 / 间距，落在既有阶梯内
- [ ] 一个视图内 `.primary` 只有一个
- [ ] 所有数字带 `tabular-nums`
- [ ] 新增主题时给了全 token，且 `ui-guard` 的三套主题比对通过
- [ ] 所有颜色走 `var(--token)`，三套主题（深 / 浅 / PS 灰）都切过去看过一遍
- [ ] 没有用到第 7 节黑名单语法
- [ ] 显示切换只用了 `.hidden`，没有 JS 写内联外观
- [ ] 状态色符合 5.4 判定，没有「为了好看」而上色
- [ ] 文案符合 5.3：没有错误码、每句错误有下一步、数字带单位
- [ ] 若属结构变更，第 5 节与 `skeleton.html` 已同步，新增的两端 DOM 差异已登记在 5.5 节
- [ ] `skeleton.html` 的 id 覆盖两端并集（`ui-guard` 会查）
- [ ] 焦点线用 `box-shadow:inset` 而不是 `outline` 边框，且每条规则都写了 `outline:0`
- [ ] 焦点态可用键盘走通，鼠标点过不残留焦点框
- [ ] 副本已同步，`node --test hosts/cep/test/*.test.js hosts/uxp/test/*.test.js` 通过
      （含 `ui-guard.test.js`：语法红线 / 阶梯 / token 完整性 / 模板 class 存在性）
- [ ] 参数分档没搞反：每次都看的进 `.param-row`（常显），有条件的开关进 `.advanced-fields`（折叠）
- [ ] 结构变更后，`ui-guard.test.js` 的结构断言（参数行 / 折叠区）仍然通过
- [ ] 280px 窄宽度下无横向滚动（用 iframe 定宽量 `scrollWidth == clientWidth`，别用截图目测）
- [ ] 本文件 9.3 版本记录已加一行
