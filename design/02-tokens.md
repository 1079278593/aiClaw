# 02 · Token 三层：Why 与 How

## 结论先行

如果只读三行，读这三行：

1. **三层思想有用，自动生成工具现在不上。** 色板 → 角色 → 组件，落点就是「`:root` / `[data-theme]` / 组件选择器」和「Dart 常量 / `ColorScheme` / widget」。Style Dictionary、Figma Variables 是什么、何时才值得用，见文末「工具链」。
2. **Android 不用单独做，成本为 0。** Flutter 的 `ColorScheme` 是平台无关层，iOS 和 Android 填的是同一个对象。只有「写平台假设」（`CupertinoButton`、硬编码 `17pt`、`Platform.isIOS`）才会变贵。
3. **当前有两个真 bug，和风格取向无关，建议先修。** ① Web 端 `tokens.css` 与 `product.css` 双份定义且值冲突；② Flutter `ColorScheme` 只填 8 个槽位，导致分割线=正文色、卡片=背景色、选中态纯主色。

## 一句话版本

颜色/间距这套东西分三层：**色板 → 角色 → 组件**。

- **色板**：有哪些值可用（`blue-500: #2563eb`）。只有配色时才看。
- **角色**：这个值代表什么（`action-primary → blue-500`）。**主题切换只改这一层。**
- **组件**：具体用在哪（`button-bg → action-primary`）。最后才做。

一条规则撑起全部价值：**组件只引用角色，不引用色板。** 守住这条，换主题就是换一层映射，而不是逐页改；守不住，暗色模式就会变成一场人肉搜索。

上面这句话是唯一必须记住的。以下都是落地细节。

## 为什么值得分层（而不是过度工程）

反例更好理解。假设按钮直接写色板值：

```css
.button { background: #2563eb; }   /* 直接引用色板 */
```

到了暗色模式，你要找遍所有文件改 `#2563eb`，还得判断每个位置暗色下该变成什么。而如果写的是角色：

```css
.button { background: var(--action-primary); }   /* 引用角色 */
```

暗色模式只需在 `html[data-theme="dark"]` 里把 `--action-primary` 重指一个值。**改一处 vs 改一百处**，这就是全部收益。

第二层收益：命名从「色相」变成「用途」。`color-action-primary` 不会因为你把品牌色从蓝换成紫而说谎；`blue-primary` 会。

## 三层在这个仓库怎么写

**现在不引入 Style Dictionary、Figma Variables、JSON 流水线。** 它们做什么、什么时候才值得上，见文末「工具链」。够用的最小实现：

| 层 | Web | Flutter |
| --- | --- | --- |
| 色板 | `tokens.css` 里 `:root` 下的原始值 | `ai_theme.dart` 里的 `Color(0xFF...)` 常量 |
| 角色 | `html[data-theme="..."]` 下的 CSS 变量 | `ColorScheme(...)` 的具名角色 |
| 组件 | `.button-primary { background: var(--accent) }` | 组件内 `Theme.of(context).colorScheme.primary` |

三层的**物理落点**就是「`:root` / `[data-theme]` / 组件选择器」和「常量 / `ColorScheme` / widget」——已经天然分离了，只是命名没统一。

## 角色槽位表

这张表是两端的**共同词汇表**。左边是唯一真相，右边两端各自映射。

| 角色 | 含义 | Web CSS 变量 | Flutter `ColorScheme` |
| --- | --- | --- | --- |
| text-primary | 标题、关键数值 | `--text1` | `onSurface` |
| text-secondary | 正文、列表 | `--text2` | `onSurfaceVariant` |
| text-muted | 时间戳、单位、提示 | `--muted` | 无（需自定义） |
| text-disabled | 禁用态 | 无 | `onSurface` + 透明度 |
| bg-page | 页面最底层 | `--bg` | `surface` |
| bg-card | 卡片、浮层 | `--bg-surface` | `surfaceContainerLow` |
| bg-raised | 更高的浮层、菜单 | `--bg-elevated` | `surfaceContainerHigh` |
| bg-subtle | 次级色块、代码块 | `--bg3` | `surfaceContainerHighest` |
| border | 分割线 | `--border` | `outlineVariant` |
| border-strong | 输入框、按钮描边 | `--border-strong` | `outline` |
| action-primary | 主按钮、选中态、链接 | `--accent` | `primary` |
| on-action | 主色上的文字 | `--accent-text` | `onPrimary` |
| action-soft | 主色的浅底（选中背景） | `--accent-soft` | `primaryContainer` |
| on-action-soft | 浅底上的文字 | **缺** | `onPrimaryContainer` |
| success | 成功 | `--success` | 无（需自定义） |
| warning | 警告 | `--warning` **缺** | 无 |
| danger | 错误 | `--danger` | `error` |
| danger-soft | 错误浅底 | `--danger-soft` | `errorContainer` |
| on-danger-soft | 错误浅底上的文字 | **缺** | `onErrorContainer` |

表里标了「缺」（Web 端没有该变量）和「无」（Flutter 端 `ColorScheme` 没有对应角色）的行，就是下一步要补的槽位。这不是设计问题，是漏填。

## 双端策略：iOS / Web / Android

### 统一的部分

- **间距用 8 点网格。** 推荐 `space-1 = 8`、`space-2 = 16`、`space-3 = 24`、`space-4 = 32`，两端共用同一组数值和语义名。Flutter 端目前是裸 `EdgeInsets`（53 处），完全没有 token。Web 端 `product.css` 已有一组**但语义不同**，见下方「最易踩的坑」。
- **颜色按角色命名**，不按色相命名。见上表。
- **圆角统一成一套。** 小元素 8 / 按钮 8～10 / 卡片 12～16 / 弹窗 16～20。Web 已有 `--radius-sm/md/lg/full`，Flutter 端没有。

### 可以不同的部分

**字号和行高不要强求跨端像素一致。** 这是主流设计系统（Material 3、Carbon、HIG）的共同做法，原因是各自要保留平台原生体验。

- iOS：走 Dynamic Type 语义样式（`.body` 17pt、`.caption` 12pt），要支持用户字体缩放。
- Android：走 M3 type scale（`bodyLarge` 16sp、`labelSmall` 11sp），单位是 sp，同样支持缩放。

在 Flutter 里这件事**已经免费**了：`TextTheme.bodyMedium` 就是那个平台无关的映射层，用系统默认字号即可，不需要 `Platform.isIOS` 分支。

### Android 到底要不要做

**不用单独做，而且顺手。** 三个理由：

1. `MaterialApp(useMaterial3: true)` 下，Android 拿到的是 `ColorScheme` 的 M3 语义角色，**和你为 iOS 填的是同一个对象**。补全 `ColorScheme` 槽位，Android 自动受益，零额外代码。
2. 字体家族当前是 `fontFamily: null`，即两端都用系统字体（iOS → SF Pro，Android → Roboto）。这已经是对的，不需要改。
3. Android 只在「你写平台假设」时才会变贵——比如用 `CupertinoButton`、硬编码 `17pt`、在代码里判断 `Platform.isIOS`。**避免这些，成本就是 0。**

反过来，**如果为 Android 单写一套 token 映射，那份代码才是该砍掉的。** 你的判断标准（「代码增加很多就不管」）在这里给出的答案是：不增加。

唯一要留意的是没设备就没法验证视觉效果。这属于验收问题，不是设计问题——token 层对齐后，Android 的观感由 M3 保证下限。

## 最易踩的坑：`--space-N` 是序号，不是倍数

`product.css` 里已有这套：

```css
--space-1: 4px;   /* 不是 8 */
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
```

它是「第几档」而不是「几个 8」。所以有两处要小心：

1. 别按 `space-N = N × 8` 的直觉去写新代码，`--space-3` 是 12 不是 24。
2. 这套值里 `4 / 12 / 20` 都不是 8 的倍数，和 [01](01-foundations.md) 的「所有间距用 8 的倍数」直接冲突。

**处理方式**：保留现有 `--space-*` 名字（改动面太大），但只用 `--space-2 / 4 / 6 / 8` 这四档（= 8 / 16 / 24 / 32）。新增代码不要引入 `--space-1 / 3 / 5 / 10`。这样既不改名，又实际落在 8 点网格上。

## 工具链是什么，现在要不要上

「工具链」指的是公司级设计系统用来**自动生成**各端代码的那条流水线，不是编辑器或构建脚本。常见三段：

| 段 | 是什么 | 作用 |
| --- | --- | --- |
| Figma Variables | 在设计稿里建变量，语义色引用色板 | 设计师改一处，画板上所有按钮跟着变；可切换亮色/暗色稿 |
| DTCG JSON | W3C 规定的 token 文件，字段是 `$value` / `$type` | 设计稿和代码之间的中立格式，不绑某一家工具 |
| Style Dictionary | 读这份 JSON，生成 CSS 变量、Swift、Android XML、Dart | 避免人手把同一个色号抄进 Web 和 App |

它解决的问题只有一个：**色板只有一份，Web 和 App 的代码是生成出来的，改色不会改漏一端。**

现在不上。原因：

1. 没有人在 Figma 里出图。Variables 会变成第二份要维护的颜色表。
2. Token 只有大约二十个角色。手写 `tokens.css` 和 `ai_theme.dart` 两处，比维护生成器便宜。
3. 当前两端不一致，是因为 `tokens.css` 和 `product.css` 各写了一遍、Flutter 槽位没填全。生成器不会修好这种重复，除非先删掉手写的那份。

以后值得上的信号：开始在 Figma 里定稿，并且改一个颜色时经常漏改 Web 或 App 其中一端。在那之前，这两份源文件就是导出结果。

ESLint 禁止裸色号同样先不上。`shell.css` 有 51 处 `var(--x, #hex)` 兜底、9 处裸 hex，全局 109 处裸圆角。规则只能拦住新增，清不掉存量。改到哪一处，就把那一处的裸值换成角色。

## 现状盘点（2026-11 实测）

写文档前量的，作为执行顺序依据：

| 项 | 现状 | 严重度 |
| --- | --- | --- |
| `tokens.css` 与 `product.css` 双份定义，值冲突 | daylight 20 个冲突、monochrome 10 个；product.css 后加载覆盖 | **高**：改 tokens.css 可能不生效 |
| Web 变量用了但没定义 | `--line` 15、`--surface-2` 12、`--warning` 2 等 12 个 | 中：有 fallback 兜底，但主题切换时会漏 |
| Flutter `ColorScheme` 只填 8 个槽位 | `outline`→`onSurface`（分割线=正文色）、`surfaceContainerHighest`→`surface`（卡片=背景色）、`primaryContainer`→`primary`（选中态纯主色） | **高**：直接违反第三节「少用颜色」 |
| 圆角无 token | Web 109 处裸值、17 种圆角（`2/4/5/6/7/8/9/10/12/14/16/18/999px/50%`…），只有 54 处走 `var()`；Flutter `3/4/6/8/12/14` 六种 | 中 |
| 间距无 token（Flutter 侧） | 53 处裸 `EdgeInsets` | 中 |
| 主题名 | 两端都是 `light(卡其) / daylight(明亮) / monochrome(墨灰)` | 无：已经对齐 |

## 与 01 的关系

[01-foundations.md](01-foundations.md) 的「起步配方」是**目标值**，现有代码是**现状**，两者目前不一致：

| 项目 | 01 规范 | 代码现状 |
| --- | --- | --- |
| 页面背景 | `#F7F8FA` | 卡其 `#EEE8D5` / 明亮 `#FFFFFF` / 墨灰 `#202020` |
| 主色 | `#4F7CFF` | 卡其 `#D9772B` / 明亮 `#2457E6` / 墨灰 `#E6E6E6` |
| 正文字号 | 16 | Web `15px`、Flutter 基准 `16` |

**这一节必须有一个决定，否则文档就是在骗人。** 两种走法：

- **A. 规范即目标**：保留规范值，逐步把代码改过去。适合「想重做视觉」。
- **B. 规范写现状**：把 01 的配方从「一套冷灰」改成「三套主题的实际值」。适合「只想要一致性，不想改样子」。

个人建议 **A + 局部修**：先修上面两个「严重度高」的 bug（和风格取向无关），再按 01 的配方把「明亮」主题作为对齐基准去逐步推进——因为现有三套主题里只有「明亮」的 `#F7F8FA` / `#1F2937` / `#E5E7EB` / `#9CA3AF` 已经和 01 配方一致，另外两套（卡其、墨灰）是风格化的，不该被规范抹平。

三套主题的定位应当写进 01：**「明亮」= 规范基准**，卡其/墨灰 = 风格化变体，只要求 token 槽位齐备，不要求色值符合配方。
