# AGENTS.md · 项目强制约定

> 任何 AI 会话或开发者在本仓库做改动前，**先读这一页**。这里写的是不可协商的约束。
> 详细技术说明见 `README.md`；**二次开发指南见 `docs/development-guide.md`**；面板视觉与布局的完整规范见 **`docs/ui-style-guide.md`**。

---

## 一、UI 改动：以基准模板为准（最高优先级）

本项目面板的视觉与布局已有**冻结的基准模板**。任何新增功能、界面调整、布局重构，
**必须**以该模板为基准实现，不允许另起风格。

| 角色 | 文件 | 什么时候读 |
|---|---|---|
| 规范条文（强制） | `docs/ui-style-guide.md` | **动手前必读** |
| 可复制骨架 | `docs/ui-template/skeleton.html` | 新建/调整 DOM 结构时 |
| 活文档预览 | `preview/ui-template.html` | 想确认某个组件长什么样时 |
| 样式唯一源 | `hosts/shared/panel.css` | 需要新样式时（先看有没有现成的） |

### 三条铁律

1. **只有一种彩色。** 全界面除琥珀 `--accent` 与语义色 `--ok/--warn/--err` 外，
   不得引入任何其它色相。多一种颜色就少一分专业感。
2. **层次靠灰阶和 1px 细线。** 不准用投影、浮层阴影、卡片堆叠、渐变背景。
3. **所有数字等宽**（`font-variant-numeric:tabular-nums`），刷新时不能左右跳。

### 硬性禁止

- ❌ 出现 `docs/ui-style-guide.md` 第 1.3 节豁免清单之外的字面色值（必须用 `var(--token)`）
- ❌ 新增字号 / 圆角 / 间距，不在既有阶梯内
- ❌ 一个视图内出现第二个 `.primary` 按钮
- ❌ 在主面板平铺新的表单区 / 整宽说明段落（短参数只能进 `.param-row` 且不超过一项一排，其余进「更多选项」，配置进设置页）
- ❌ 使用 Chromium 61 不支持的语法：`flex` 的 `gap`、`:has`、`:is`、`clamp()`、
  `conic-gradient`、`accent-color`、`aspect-ratio`、`inset:0`
- ❌ 直接修改 `hosts/cep/css/panel.css` 或 `hosts/uxp/css/panel.css`
- ❌ 在渠道行里再放独立指示灯，或把「类别 + 状态」拼回一整句话（状态色只上在 `.provider-chip` 一处）
- ❌ 在 `<button>` 里再套 `<button>`（胶囊是 `span`，嵌套按钮点击会失效）

### 新增功能的落位规则（按序判断）

1. 新的「做什么」→ 加一个 `.mode` 分段项
2. 每次都要看一眼的短参数 → 进 `.param-row`（一行 2~3 项，标签在上，常显）；有强绑条件的开关 → 进 `.advanced-fields`，默认折叠
3. 配置 / 凭据 / 服务状态 → 进设置页对应 `.group`
4. 操作结果 → 进 `.previews` 卡片区，或复用 `.status` 一句话
5. 持续显示的状态 → 复用 `.provider` 信号行形态
6. 都不是 → 先在 `hosts/shared/panel.css` 用既有 token 实现，再更新规范第 4 节

### 改结构 / 改某个界面（不是加功能，是动布局）

规范是**活文档**：改界面必须同步改规范，否则下一次改动就没有基准了。

| 改动性质 | 判定 | 必须同步 |
|---|---|---|
| 视觉调整 | 只改颜色/字号/间距 | `panel.css` + 规范 token 或阶梯表 |
| 局部调整 | 区块内换内容 / 调文案 | 必要时同步规范第 4 节组件表 |
| **结构变更** | 调换区块顺序、增删区块、新增整页视图 | **先改规范第 5 节 + `skeleton.html`，再改代码** |

- 新增整页视图只能是**覆盖层**：复用 `.settings` 的 `position:fixed` + 四边 `0` 定位，
  同一时间只允许一层，入口只有一个。
- 没有媒体查询断点，不写 `@media (max-width:…)`；最小可用宽度 280px。
- 每次改完规范，在 9.3 版本记录加一行。联动明细见规范 9.1 表。

---

## 二、样式与逻辑的唯一源

`hosts/shared/` 是唯一源，`hosts/cep/`、`hosts/uxp/` 里的同名文件是**逐字节副本**
（CEP 用 `<script>` 加载、UXP 用 `require`，打包结构不同只能各放一份）。

改完必须同步并验证：

```bash
# 推荐使用根目录一键同步与验证脚本（跨平台自动同步 5 个唯一源并比对）
npm run sync
npm run verify

# 或手动复制
cp hosts/shared/panel.css hosts/cep/css/panel.css
cp hosts/shared/panel.css hosts/uxp/css/panel.css
node --test hosts/cep/test/*.test.js hosts/uxp/test/*.test.js
```

涉及 `panel.js` / `channel-view.js` / `compare-view.js` / `theme.js` 时同理。`panel-parity.test.js` 会逐字节比对，不一致直接失败。

`hosts/cep/test/ui-guard.test.js` 是规范的**可执行版本**，它会拦下：

- Chromium 61 黑名单语法（`:has` / `:is` / `clamp()` / `conic-gradient` / `aspect-ratio` / `inset:` / `gap:` / 裸 `min()` `max()`）
- 阶梯外的字号（只允许 10/11/11.5/12/12.5/13/14）与圆角（0~10px + 50%）
- `:root` 之外的不透明色值（必须在 token 里，否则换主题不跟）
- `var(--x)` 引用但未定义的 token
- 浅色 / PS 灰主题漏覆盖的 token（三套主题必须等长）
- `skeleton.html` 里用了不存在的 class
- 三个短参数（`#count` / `#seed` / `#size`）不在 `.param-row` 里，或被塞回折叠区
- 两端 DOM 出现了**未登记**的差异（登记表在规范 5.5 节，目前只有 `#start-service` 和 `#cost-confirm`）
- `skeleton.html` 的 id 没覆盖两端并集

**改阶梯数值时，规范和这个测试的白名单必须一起改。** 两处不一致本身就是 bug。
DOM 结构改动后，`preview/live.html` 需同步同一套 id。

---

## 三、跨端几何约定

- **`canvasBounds` 是几何真值**：扩图只用它算「原照片在画布里的位置」；alpha 反推是备胎。
- **结果图必须是画布尺寸，且只有新增区有像素**：`apply` 依赖这个前提贴成独立图层。

---

## 四、交付前自检

- [ ] 已按 `docs/ui-style-guide.md` 第 10 节逐条过一遍
- [ ] 副本已同步，`node --test` 通过
- [ ] 280px 窄宽度下无横向滚动
- [ ] 键盘 Tab 能走通，焦点态可见；鼠标点过不残留焦点框
- [ ] 焦点线用 `box-shadow:inset 0 0 0 1px var(--focus-line)`，不用 `outline` 画线（`ui-guard` 会查）
- [ ] 视觉有变化时，同步更新 `docs/ui-style-guide.md`
