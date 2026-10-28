# aiClaw UI 改进方案

## 范围与约束

| 维度 | 约束 |
|---|---|
| 后端代码 | 小幅改动（`static-assets.ts` 加 vendor 白名单、`package.json` 加 lucide 依赖），不动功能逻辑 |
| 前端代码 | 只改 `src/server/public/` 下的 HTML/CSS/JS |
| 构建/API/协议/CLI | ❌ 不动 |
| 现有功能 | ✅ 全部保留（三套主题、字体选择、字号滑块等）；左栏拖拽 resize 经确认替换为折叠切换 |
| 新增/修改的文件 | `package.json`、`pnpm-lock.yaml`、`static-assets.ts`（仅加 vendor 白名单） |
| 新依赖 | `lucide`（通过 `/vendor/lucide/...` 路径，UMD 脚本标签接入） |
| 目标风格 | 简洁现代风（参考 ChatGPT / Claude） |

---

## 现状评估

功能上已经比较完整——流式渲染、推理块折叠、工具调用展示、文档浏览器、多主题、知识库、Token 统计、文件选择器等都在正常工作。但 UI 层面确实存在明显的"粗糙感"，整体更接近开发调试面板而非 polished 产品。

---

## 当前的主要问题

### 1. 纯开发工具风格

整体像一个内部调试面板，缺乏"产品感"。配色、圆角、间距都比较随意，没有精心打磨的视觉层次。

### 2. 缺少过渡动画

弹窗开关、会话切换、消息出现都是瞬间闪现，没有渐变/滑入等过渡效果。用户操作缺乏反馈感。

### 3. 图标非常简陋

只用少量内联 SVG + 文本符号（⚙、×、↑、›），很多按钮只有文字没有图标。视觉上不够直观。

### 4. 代码块无语法高亮

~~pre/code 只是换了个背景色，没有 highlight.js 或 Prism 之类的语法着色，阅读代码体验差。~~ → **去掉，不处理。**

### 5. 会话列表太朴素

纯文字列表，没有时间分组、没有搜索/过滤、没有 pin 功能。会话多了之后难以管理。

### 6. 排版层次弱

字号、字重变化少，信息层级不清晰；markdown 渲染虽然功能全但视觉平淡，标题与正文区分度不够。

### 7. 输入区域功能性强但不够精致

Composer toolbar 控件挤在一起，toggle、select、按钮风格不统一，视觉上比较杂乱。

### 8. 空状态很"冷"

"请选择或新建一个对话"、"暂无统计数据"——纯文字无图标无引导，显得 unfinished。

### 9. 滚动条不统一

有的地方用 thin scrollbar，有的地方没处理，视觉不一致。

### 10. 缺乏响应式考虑 + 侧栏交互弱

全是固定像素布局，窗口缩窄时体验不佳。左右侧栏只能拖拽调整宽度，没有快速收起/展开的交互。

---

## 做得好的地方（值得保留）

- **CSS 变量体系** (`tokens.css`) 设计合理，三套主题切换机制干净
- **模块化 JS 架构** 清晰，`features/`、`render/` 分离得当
- **流式渲染策略**（按空行分段触发 markdown 渲染）是一个聪明的优化
- **文档浏览器三栏布局** 的想法不错

---

## 改进优先级

### P0 — 设计基础 + 图标

- **设计 token 升级**（第 1 项）：间距体系（4px 倍数）、圆角层级（sm/md/lg/full）、阴影分层（sm/md/lg）、配色微调
- **引入 Lucide 图标库**（第 3 项）：替换所有文本符号和零散内联 SVG
- **排版层次**（第 6 项）：字号阶梯、字重分层、标题颜色区分、行高统一、段落间距
- **滚动条统一**（第 9 项）：全局规则，删除重复样式

### P1 — 过渡动画 + 组件打磨

- **过渡动画**（第 2 项）：弹窗/下拉/popover 的淡入滑入、hover 过渡补齐、消息淡入
- **空状态**（第 8 项）：三层信息（图标+标题+引导文字）
- **Composer 精简化**（第 7 项）：左组缩为图标按钮（方案 C）

### P2 — 布局增强

- **左右侧栏收起/展开**（第 10 项）：切换按钮，窄条模式，状态持久化

### ❌ 去掉

- 代码块语法高亮 → 不需要

### ⏸ 暂缓

- 会话列表搜索/筛选/分组/pin
- 输入区域拖拽图片
- 快捷键提示
- 右栏文档浏览器重新设计

---

## 逐项讨论记录

### 1. 纯开发工具风格

> "开发工具风格"指：布局靠边框和背景色区分区域（像控制台面板）、颜色纯功能化（红=错绿=对）、间距随手给、没有过渡动画。
> 目标是"简洁现代产品风"：靠留白和阴影区分层次、颜色有意图、间距有节奏、交互有反馈。参考 ChatGPT / Claude。

**方向**：简洁现代风（参考 ChatGPT / Claude）

**核心思路**：先升级 `tokens.css` 设计 token 体系，再渐进对齐现有组件。不改功能，只改视觉。

#### 1.1 间距体系：统一 4px 倍数

**适用范围**：padding、margin、gap 等布局间距。字号、图标尺寸、border-width 不受此约束。

目前 padding/margin 值散落在 8/10/12/14/16/18/20/22px，没有规律。改为：

```
--space-1:  4px
--space-2:  8px
--space-3:  12px
--space-4:  16px
--space-5:  20px
--space-6:  24px
--space-8:  32px
--space-10: 40px
```

现有组件逐个对齐，替换掉 10/14/18/22 等非标值。

#### 1.2 圆角层级

当前圆角值散乱（5/6/8/9/10/12/14/999px），缺少规范。建立三层圆角 token：

```
--radius-sm: 6px    // 小元素：badge、toggle、inline button
--radius-md: 10px   // 卡片、输入框、下拉面板
--radius-lg: 16px   // 弹窗、消息气泡
--radius-full: 999px // 药丸形按钮
```

#### 1.3 阴影分层

目前几乎没有阴影使用。引入三层阴影 token，用于表达 z-index 层级：

```
--shadow-sm:  0 1px 2px rgba(0,0,0,0.04)     // hover 态、卡片默认
--shadow-md:  0 4px 12px rgba(0,0,0,0.06)    // 下拉菜单、popover
--shadow-lg:  0 8px 30px rgba(0,0,0,0.10)    // 弹窗
```

#### 1.4 配色调整

当前三套主题保留，但每套内部调整：
- 侧栏与主区域要有明确区分度（侧栏稍暗/稍灰）
- accent 色要更活跃地使用（链接、选中态、高亮）
- 增加一个微妙的 surface 层级（`--bg-surface`），用于卡片和气泡

**实施策略**：先改一套主题（如 daylight 明亮主题），验证通过后把对应映射到另外两套。三套主题变量结构一致但色值独立，逐套调试验收。

具体色值在实现时逐主题调试。

#### 1.5 字体和排版

- 全局正文字号从 14px 提升到 15px（`--text-base: 15px`）
- 行高从 1.5~1.66 统一到 1.6
- markdown 标题加大对比度：h1 1.6em、h2 1.3em、h3 1.1em
- 字重分层：`400`(正文) / `500`(medium, 强调) / `600`(semibold, h3) / `700`(bold, h2/strong) / `800`(extrabold, h1)
  - **注意**：不用 `font-weight: 550`，多数非可变字体会映射到 500 或 600，效果不可预测

#### 字号滑块边界

- 滑块只控制 Markdown 正文（`--md-font-size`），不影响全局 UI 字号
- 默认值从 14px 同步改为 15px，与 `tokens.css` 初始值一致
- `settings.js` 中 `|| 14` 改为 `|| 15`

#### 实施步骤

1. 改造 `tokens.css`，新增间距/圆角/阴影 token，调整色值
2. 逐个 CSS 文件用新 token 替换硬编码值
3. 按批次目视验证（见"实施批次"一节）

---

### 2. 缺少过渡动画

**原则**：纯 CSS 方案，不引入动画库。两类动画策略：

#### A. 出现/消失类（弹窗、下拉、popover）

不能用 `display:none`（无法被 transition 动画化），统一用 `visibility` + `opacity` + `pointer-events` 三件套。

```css
/* 弹窗 backdrop 淡入 */
.modal {
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transition: visibility 0s 0.2s, opacity 0.2s;
}
.modal.open {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
  transition: visibility 0s 0s, opacity 0.2s;
}

/* 面板 scale 弹入 */
.modal-panel {
  transform: scale(0.95);
  transition: transform 0.2s ease-out;
}
.modal.open .modal-panel {
  transform: scale(1);
}
```

关键细节：
- **打开瞬间**：`visibility` 立即可见（delay 0s），`opacity` 淡入
- **关闭时**：`opacity` 先淡出 0.2s，然后 `visibility` 延迟隐藏（delay 0.2s）
- **`pointer-events: none`**：保证隐藏时不拦截底层按钮点击

#### B. 持续存在类（hover、消息出现等）

```css
/* 全局补齐 hover 过渡 */
button, .session-item, .doc-entry {
  transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
}

/* 新消息淡入上移（仅新追加的消息，非全量） */
.message.message-new {
  animation: fadeInUp 0.3s ease-out;
}
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* 切换会话时只给容器加快速淡入，不给内部消息加动画 */
#messages.session-transition {
  opacity: 0;
  transition: opacity 0.15s;
}
#messages {
  opacity: 1;
  transition: opacity 0.15s;
}
```

**会话切换动画的 JS 触发**：仅定义 CSS 不会自动淡回。JS 必须先加 `.session-transition` 类（opacity:0），在 `requestAnimationFrame` 回调中渲染新内容后移除该类，浏览器才能先提交隐藏帧再开始淡入动画：

```js
function switchSession() {
  const container = document.getElementById('messages');
  container.classList.add('session-transition');

  requestAnimationFrame(() => {
    // 渲染新会话消息...
    container.classList.remove('session-transition');
  });
}
```

#### 动画降级：prefers-reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
}
```

用户系统设置了"减少动态效果"时，所有动画/过渡全部清零，弹窗的 `visibility` delay 也一并归零，不会有残留延迟。

#### 需要处理的位置

| 位置 | 动画 | 方式 |
|---|---|---|
| `#usage-modal` / `#knowledge-modal` / `#compact-modal` | backdrop 淡入 + 面板 scale 弹入 | visibility/opacity + transform transition |
| `#settings-dropdown` | 从底部滑入 | opacity + translateY |
| `.settings-submenu` | 从左淡入 | opacity + translateX(-4px) |
| `#file-picker-popover` / `#command-picker-popover` | 从底部弹入 | opacity + translateY |
| `#tool-permission-dialog` | 从底部弹入 | opacity + translateY |
| 新消息出现 | 淡入 + 微微上移 | `.message-new` 一次性类，animation 结束后移除 |
| 会话切换 | 消息容器快速淡入 | `.session-transition` 容器级 transition |
| 按钮/链接 hover | 背景色、边框色过渡 | 补全 transition |

#### details 展开折叠（推理块/工具块）

原生 `<details>` 展开是瞬时的。目前方案：
- **先只做 summary caret 旋转动画**（已有），内容展开保持瞬时
- 等 `interpolate-size: allow-keywords` 浏览器支持成熟后再加平滑展开
- 不动 JS 逻辑

#### 实施注意

目前弹窗用 `display:none/block` 控制（如 `.open { display: flex; }`），需要改为 `visibility` + `opacity` 方案。JS 中 `.classList.toggle('open')` 逻辑保持不变，只需改 CSS。

---

### 3. 图标非常简陋

**方案**：引入 [Lucide](https://lucide.dev) 图标库（MIT 协议），替换所有文本符号和零散内联 SVG。

#### 接入方式

```bash
pnpm add lucide
```

在 `static-assets.ts` 的 vendor 白名单中增加 lucide：

```ts
const VENDOR_ASSET_ROOTS = {
  "markdown-it": join(NODE_MODULES_DIR, "markdown-it", "dist"),
  katex: join(NODE_MODULES_DIR, "katex", "dist"),
  lucide: join(NODE_MODULES_DIR, "lucide", "dist"),
} as const;
```

在 `index.html` 中以普通 `<script>` 标签加载 UMD 构建（非 ES module）：

```html
<script src="/vendor/lucide/umd/lucide.min.js"></script>
```

HTML 中用 `data-lucide` 属性标记图标位置，JS 中调用 `window.lucide.createIcons()` 渲染：

```html
<button id="settings-btn"><i data-lucide="settings"></i></button>
```

```js
window.lucide.createIcons();
```

优势：UMD 方式零额外配置，不需要加 MIME 类型。size / stroke-width / color 统一受 CSS 控制。

#### 动态图标自动刷新

不使用各调用点分散调 `createIcons()` 的方式，而是用 **MutationObserver** + **requestAnimationFrame** 合并批次，统一重新渲染：

```js
let iconScheduled = false;
const iconObserver = new MutationObserver(() => {
  if (!iconScheduled) {
    iconScheduled = true;
    requestAnimationFrame(() => {
      window.lucide.createIcons();
      iconScheduled = false;
    });
  }
});
iconObserver.observe(document.body, { childList: true, subtree: true });
```

`rAF` 将同一帧内的多次 DOM 变更合并为一次渲染，Lucide 内部自动跳过已渲染的图标。这样无论 `renderChatArea()`、会话删除、消息重启、文档树动态插入，都能自动捕获并渲染图标。

#### 无障碍要求

所有纯图标按钮必须保留 `aria-label`（不能只依赖 `title`）：
```html
<button aria-label="设置" title="设置"><i data-lucide="settings"></i></button>
```

折叠/展开按钮额外加 `aria-expanded`，切换时同步更新 DOM 属性。

#### 需要替换的图标清单

| 位置 | 现状 | 改为 lucide icon |
|---|---|---|
| 设置按钮 | `⚙` | `settings` |
| 关闭按钮 | `×` | `x` |
| 发送按钮 | `↑` | `arrow-up` |
| 折叠箭头 | `›` | `chevron-right` |
| 新建会话 | 文字 "+ 新建" | `plus` + 文字 |
| Compact | 文字 "Compact" | `shrink` |
| 删除会话 | `×` | `trash-2` |
| 刷新文档 | 文字 "刷新" | `refresh-cw` |
| 编辑文档 | 文字 "编辑" | `pencil` |
| 清除选择 | 文字 "清除" | `x-circle` |
| 文件选择器按钮 | 无 | `paperclip` |
| 命令选择器按钮 | 无 | `terminal` |
| 知识库按钮 | 现有内联 SVG | `book-open` |
| Token 按钮 | 现有内联 SVG | `bar-chart-3` |
| 重启按钮 | 现有内联 SVG | `refresh-ccw` |
| 空状态图标 | 现有内联 SVG | `message-circle` |
| 左栏折叠 | 无 | `panel-left-close` / `panel-left-open` |
| 右栏折叠 | 无 | `panel-right-close` / `panel-right-open` |
| 状态指示灯 | `.status-dot` div | 保留，不需要改 |

---

### 4. 代码块无语法高亮

→ **去掉，不处理。**

### 5. 会话列表太朴素

→ **暂缓，先不处理。**

### 6. 排版层次弱

#### 6.1 字号阶梯

```css
--text-xs:   12px   /* 辅助信息（时间戳、meta） */
--text-sm:   13px   /* 次要文本 */
--text-base: 15px   /* 正文（从 14px 提升） */
--text-lg:   17px   /* h3 */
--text-xl:   20px   /* h2 */
--text-2xl:  26px   /* h1 */
```

#### 6.2 字重分层

```css
--weight-normal:   400  /* 正文 */
--weight-medium:   500  /* 强调、h4 */
--weight-semibold: 600  /* h3 */
--weight-bold:     700  /* h2、strong */
--weight-extrabold:800  /* h1 */
```

> 不用 550——多数非可变字体会映射到 500 或 600，效果不可预测。

#### 6.3 颜色分层

```
h1: var(--text1)        /* 最深 */
h2: var(--text1)
h3: var(--text2)        /* 中等 */
正文 p: var(--text)     /* 略灰 */
辅助: var(--muted)      /* 最淡 */
```

#### 6.4 行高统一

```
正文 / markdown p:  1.6
标题 h1-h4:         1.3
代码块 pre:         1.5
```

#### 6.5 段落间距

段落间距从 `0.58em` 改为 `1em`，节奏更舒适。

#### 6.6 字号滑块与全局字号的关系

- 字号滑块（`#font-size-slider`）只控制 `--md-font-size`，即 Markdown 正文和文档预览区
- 默认值从 14px 改为 15px（`settings.js` 和 `tokens.css` 同步更新）
- 全局 UI 正文走 `--text-base: 15px`，不受滑块影响
- 标签同步更新

#### 总结

| 改什么 | 改之前 | 改之后 |
|---|---|---|
| 正文字号 | 14px | 15px |
| 字号层级 | 无 token | xs/sm/base/lg/xl/2xl |
| 字重 | 600~800 挤在一起 | 400/500/600/700/800 分层 |
| 标题颜色 | 与正文同色 | h1/h2 更深 |
| 段落间距 | 0.58em | 1em |
| 行高 | 1.5~1.66 不一 | 正文 1.6，标题 1.3 |
| 滑块默认值 | 14px | 15px |

改动集中在 `tokens.css` 的 `:root`、`chat.css` 的 `.markdown-body`、`settings.js` 的默认值。

---

### 7. 输入区域功能性强但不够精致

**问题**：composer toolbar 中 write toggle、Compact、provider/model/thinking 下拉、发送按钮全是一种边框风格挤在一起，看不出层次。

**方案 C**：左组（write toggle、Compact）缩小为纯图标按钮，右组（provider/model/thinking 下拉 + 发送按钮）保持现状。

```
[✎] [🗜]                        [provider ▾] [model ▾] [thinking ▾] [↑]
 30px 方形图标                   32px 文字下拉，保持现状
 无边框（hover 显背景）           有边框
```

形状和有无边框天然拉开层次：左边是"设置/操作"，右边是"消息配置"。

- write toggle: `pen-line` 图标，激活时高亮 accent 色
- Compact: `shrink` 图标，会话不够长时 disabled/灰色
- hover 出 tooltip 提示功能

Composer 原布局不变，只改左组控件形态。

---

### 8. 空状态很"冷"

**原则**：每个空状态三层信息——图标 + 标题 + 引导文字。只加文案，不增加交互。

| 位置 | 现状 | 改为 |
|---|---|---|
| `#no-session` | "请选择或新建一个对话" | 图标 + "欢迎回来" + "选择一个会话或新建一个开始对话" |
| `#empty-state` | 图标 + "发送消息开始对话" | 保留结构，换 lucide 图标 |
| `#usage-empty` | "暂无统计数据" | 图标 + "暂无数据" + "发送消息后即可查看 Token 统计" |
| `#knowledge-empty` | "暂无知识库" | 图标 + "暂无知识库" + "在数据目录中配置知识库即可使用" |

格式统一：`<大图标> + <标题> + <引导文字>`。引导文字用 `--muted` 色，字号 13px。

---

### 9. 滚动条不统一

**方案**：在 `tokens.css` 加一段全局滚动条规则，删除各处重复的手写样式。

```css
/* 全局 */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}
```

`#messages` 保留 hover 渐显效果：
```css
#messages {
  scrollbar-color: transparent transparent;
  transition: scrollbar-color 0.3s;
}
#messages:hover {
  scrollbar-color: var(--border) transparent;
}
```

然后删掉 `.doc-column-body::-webkit-scrollbar`、`.panel-scroll-body::-webkit-scrollbar`、`#doc-preview-content::-webkit-scrollbar` 等重复规则。

---

### 10. 响应式 + 侧栏收起/展开

**定位**：本地桌面应用，不做移动端适配。聚焦窗口缩窄场景。

#### 10.1 Composer 自适应

```css
/* 改前 */
#composer { width: min(810px, calc(100vw - 300px)); }

/* 改后 */
#composer { width: 100%; max-width: 810px; margin: 0 auto; }
```

#### 10.2 左栏 `#sidebar`

**去掉拖拽 resize**，改为纯折叠切换模式：

- 默认宽度：`clamp(180px, 18vw, 280px)`——随屏幕大小自适应
- 无 resize 手柄，无 `#sidebar-resize`
- 折叠按钮：放在侧栏右边缘，与 "aiClaw" 标题同行
- 新建按钮：下移到下一行

```
展开状态：                    折叠状态（窄条 ~44px）：
┌──────────────┐              ┌──┐
│ aiClaw   ◀  │              │▶ │  ← 展开按钮
│ [+ 新建]     │              │  │
│              │              │  │
│  会话列表    │              │⚙ │  ← 设置
│  ...         │              │● │  ← 状态灯
│              │              └──┘
│ ⚙ 设置       │
│ ● 已连接     │
└──────────────┘
```

状态持久化：
- `localStorage` key `sidebarCollapsed`（boolean）
- 展开时宽度由 CSS `clamp()` 自动决定，无需存储

#### 10.3 右栏 `#action-rail`

保留拖拽 resize，额外加折叠切换：

- 默认宽度：`clamp(280px, 30vw, 420px)`
- 拖拽范围：280px – 1000px
- 折叠按钮：放在右栏**内部左边缘**，一个独立的 24×24 小按钮，浮在文件树左上角附近。拖拽手柄（`#doc-rail-resize`）保持独立 6px，点击与拖拽互不干扰

```
正常状态：                           折叠状态（窄条 ~44px）：
┌────────────┬──┬────────────┐      ┌────────────┬──┐
│  聊天区    │◀│  文件树     │      │  聊天区    │◀ │  ← 展开按钮
│            │  ├────────────┤      │            │  │
│            │  │  预览区     │      │            │  │
└────────────┴──┴────────────┘      └────────────┴──┘
         6px独立拖拽  ↑折叠按钮
                     在右栏内部左边缘
```

状态模型（三个独立变量，互不冲突）：

| 变量 | 存储 | 说明 |
|---|---|---|
| `docRailCollapsed` | `localStorage` | 是否收起（boolean） |
| `docRailWidth` | `localStorage` | 展开时的宽度，拖拽更新 |
| 默认宽度 | CSS `clamp(280px, 30vw, 420px)` | 无 localStorage 记录时使用 |

初始化逻辑：
```
collapsed = localStorage.getItem("docRailCollapsed") === "true"
width = localStorage.getItem("docRailWidth") || CSS clamp 计算值

if collapsed → action-rail 显示为窄条
else         → action-rail 宽度 = width
```

拖拽仅在展开状态下生效，更新 `docRailWidth` 并写入 localStorage。折叠按钮切换 `docRailCollapsed`，展开时恢复到 `docRailWidth`。

#### 10.4 不做的事

- 不做 hamburger 菜单
- 不做触屏手势

---

## 可访问性规范

### 弹窗 / 浮层

按交互类型分三类处理：

#### A. 真 Modal（阻断式对话框）

**组件**：`#usage-modal`、`#knowledge-modal`、`#compact-modal`、`#tool-permission-dialog`

| 项目 | 说明 |
|---|---|
| `role="dialog"` | HTML 属性标记 |
| `aria-modal="true"` | 告知屏幕阅读器背景不可交互 |
| Esc 关闭 | keydown 监听，Esc 触发关闭 |
| 打开后聚焦 | 聚焦弹窗内第一个可聚焦元素或关闭按钮 |
| 关闭后恢复焦点 | 记住打开前聚焦的元素，关闭后 focus 回去 |

建议实现：写一个通用的 `openModal(id)` / `closeModal()` 辅助函数，统一处理焦点管理、Esc 监听、aria 属性切换。

#### B. Popover/Menu（浮层式）

**组件**：`#settings-dropdown`、`.settings-submenu`

| 项目 | 说明 |
|---|---|
| `aria-expanded` | 触发按钮上标记展开状态 |
| 点击外部关闭 | 全局 click 监听，点击浮层外则关闭 |
| Esc 关闭 | 同上 |

#### C. Listbox/Combobox（选择器）

**组件**：`#file-picker-popover`、`#command-picker-popover`

| 项目 | 说明 |
|---|---|
| `role="listbox"` | 选项列表语义 |
| 键盘导航 | ↑↓ 移动选项，Enter 确认，Esc 关闭 |
| `aria-activedescendant` | 当前高亮选项 |

### 图标按钮

- 所有纯图标按钮必须有 `aria-label="功能描述"`，不能只依赖 `title`
- 折叠/展开按钮额外加 `aria-expanded="true/false"`，切换时同步更新
- 侧栏区域加 `aria-label` 区分（如 `aria-label="会话列表"`）

### 动画降级

`prefers-reduced-motion: reduce` 时全局禁用动画和过渡（见第 2 节）。

---

## 验收矩阵

### 主题

| 检查项 | 米黄 (light) | 明亮 (daylight) | 墨灰 (monochrome) |
|---|---|---|---|
| 侧栏与主区域区分度 | ✅ | ✅ | ✅ |
| accent 色活跃度 | ✅ | ✅ | ✅ |
| Markdown 内容可读 | ✅ | ✅ | ✅ |
| 选中态/禁用态/错误态 | ✅ | ✅ | ✅ |

### 字号

| 检查项 | 10px | 15px (默认) | 20px |
|---|---|---|---|
| Markdown 正文 | ✅ | ✅ | ✅ |
| UI 全局字号不变 | ✅ | ✅ | ✅ |
| 滑块与 CSS 同步 | ✅ | ✅ | ✅ |

### 侧栏

| 检查项 | 通过 |
|---|---|
| 左栏展开（默认宽度自适应） | ✅ |
| 左栏收起为窄条（图标可见） | ✅ |
| 右栏展开（默认宽度自适应） | ✅ |
| 右栏收起为窄条（展开按钮可见） | ✅ |
| 右栏拖拽 resize（280-1000px） | ✅ |
| 两边同时收起（聊天区全宽） | ✅ |
| 刷新后状态保持 | ✅ |

### 会话

| 检查项 | 通过 |
|---|---|
| 空会话（无消息，显示空状态） | ✅ |
| 长会话（大量消息，滚动正常） | ✅ |
| 流式消息（新消息淡入上移，历史消息不动） | ✅ |
| 会话切换（容器淡入，消息不动） | ✅ |
| 消息重启按钮 hover 显示 | ✅ |

### 弹窗

| 检查项 | usage | knowledge | compact | tool-permission | settings | file-picker |
|---|---|---|---|---|---|---|
| 类型 | Modal | Modal | Modal | Modal | Popover | Listbox |
| 淡入动画 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 关闭动画 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Esc 关闭 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 焦点管理 | ✅ | ✅ | ✅ | ✅ | — | — |
| 不遮挡底层交互 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `prefers-reduced-motion` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 窗口宽度

| 检查项 | 通过 |
|---|---|
| 800px（右栏自动收起） | ✅ |
| 1024px（三栏正常） | ✅ |
| 1280px（三栏舒适） | ✅ |
| 1440px（三栏宽裕） | ✅ |

### 显示缩放

| 检查项 | 通过 |
|---|---|
| Windows 100% 缩放 | ✅ |
| Windows 125% 缩放 | ✅ |

---

## 实施批次

按以下四批顺序实施，每批改完目视验证一轮：

### 批次 1：设计 token（tokens.css）

间距、圆角、阴影、字号、字重、配色（先 daylight 主题）

### 批次 2：基础组件

按钮、输入框、滚动条、空状态、lucide 图标接入 + MutationObserver

### 批次 3：Composer + 弹窗

Composer 左组图标化、弹窗动画 + 可访问性（Esc/焦点/aria）

### 批次 4：布局

左栏折叠（去 resize）、右栏折叠（保留 resize）、Composer 自适应