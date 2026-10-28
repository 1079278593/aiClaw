# 阶段 8 实施计划：用户体验优化

## 目标
三件事：发送中状态、错误统一进聊天流、Compact 自定义确认框。

---

## 任务一：发送中状态 + 打字动画

### 现状
- `isStreaming` 已有，`chatStart` 时 `setSendDisabled(true)`，`chatEnd`/`error` 时恢复
- 但 `sendMessage()` 发出消息到服务端回 `chatStart` 之间有空窗期，输入框未禁用
- 没有任何视觉动效表示 AI 正在生成

### 改动

**1. 发送后立即禁用**
在 `sendMessage()` 发送后立即调用 `setSendDisabled(true)`，不等 `chatStart`。

**2. 打字动画**
`chatStart` 时在 assistant 气泡内插入一个 `<div class="typing-dots">` 占位，包含三个跳动的点。
`chatChunk` 收到第一个 chunk 时移除该占位。

CSS 动画：方案 A，三个圆点依次上下跳动（`@keyframes bounce`，stagger delay 0.2s）。

**3. 发送按钮状态**
`isStreaming` 为 true 时按钮文字改为 "..." 或加 disabled 样式，回复完成后恢复。

### 涉及文件
- `src/server/public/index.html`：CSS 加动画，JS 改 `sendMessage`、`handleServerMessage` 的 `chatStart`/`chatChunk`

---

## 任务二：错误统一进聊天流

### 现状
- `showError()` 已存在，插入聊天流，但样式是小红字不显眼
- `compactCurrentSession()` 失败用 `alert()`
- WebSocket 断开只改状态点颜色，无文字提示

### 改动

**1. 加强 `showError()` 样式**
改为更醒目的错误卡片：左侧红色竖线 + 图标 + 文字，背景浅红，圆角。

**2. 压缩失败改用 `showError()`**
`compactCurrentSession()` catch 块里把 `alert()` 换成 `showError()`。

**3. WebSocket 断开提示**
`setStatus(false)` 时，如果当前有 session，调用 `showError("连接断开，正在重连...")`。
重连成功（`setStatus(true)`）时不重复提示。
避免重复：用一个 `disconnectNotified` flag，断开时置 true，重连后清除。

### 涉及文件
- `src/server/public/index.html`：CSS 改 `showError` 样式，JS 改 `compactCurrentSession`、`setStatus`

---

## 任务三：Compact 自定义确认框

### 现状
- `compactCurrentSession()` 用浏览器原生 `confirm()`，风格不统一

### 改动

**HTML**：新增 `#compact-modal` + `#compact-panel`，结构与 `#usage-modal` / `#knowledge-modal` 完全一致：
```
#compact-modal > #compact-panel
  #compact-panel-header > strong("压缩会话")
  p("原始记录将归档，会话将替换为摘要。确认继续？")
  #compact-panel-footer > #compact-cancel-btn + #compact-confirm-btn
```

**CSS**：复用 `#usage-modal` / `#usage-panel` 的样式规则，selector 扩展加上 `#compact-modal` / `#compact-panel`。

**JS**：
- `compactCurrentSession()` 改为打开 modal（`classList.add("open")`），不再调用 `confirm()`
- `#compact-cancel-btn` 点击关闭 modal
- `#compact-confirm-btn` 点击执行实际压缩逻辑（原 `compactCurrentSession` 的 fetch 部分提取为 `doCompact()`）
- 点击 modal 背景关闭（与其他 modal 一致）

### 涉及文件
- `src/server/public/index.html`：HTML 加 modal，CSS 扩展选择器，JS 拆分逻辑

---

## 任务四：按钮 hover 去蓝

### 现状
toolbar 按钮（Token Stats、Compact 等）和 rail 按钮 hover 时变蓝色文字 + 蓝色背景，与 Solarized 主题不搭。

### 改动
将 `#compact-btn:hover:not(:disabled), .toolbar-select:hover, .toolbar-select:focus` 的 hover 样式改为：
- `border-color: var(--border-strong)`（沙色 `#b9ad8f`）
- `background: var(--bg2)`
- `color: var(--text2)`（不变色）

同样处理 `.rail-btn:hover`。

### 涉及文件
- `src/server/public/index.html`：CSS 改两处 hover 规则

---

## 实施顺序

1. 任务四（按钮 hover 去蓝）— 纯 CSS，最简单
2. 任务三（Compact 确认框）— 独立，风险低
3. 任务二（错误统一）— 改现有逻辑，需注意 flag 管理
4. 任务一（发送中状态）— 涉及动画 CSS，最后做

---

## 验收

- [ ] toolbar 按钮 hover 无蓝色，边框变沙色，背景变 bg2
- [ ] 发送消息后输入框立即禁用，AI 气泡出现打字动画
- [ ] 收到第一个 chunk 后动画消失，正常显示文字
- [ ] 压缩失败显示聊天流错误卡片，不弹 alert
- [ ] WebSocket 断开时聊天流出现断开提示
- [ ] Compact 按钮弹出自定义确认框，风格与其他 modal 一致
