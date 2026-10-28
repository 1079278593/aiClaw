# 并发会话支持 - 实施计划

## 目标

A 会话生成中，用户可以切换到 B 会话正常工作，A 会话在后台继续生成并持久化消息。切换回 A 时能看到已生成的内容。

## 当前架构分析

### 现状

| 层面 | 现状 | 问题 |
|------|------|------|
| 服务端 | `processChatMessage` 是 fire-and-forget，`broadcastToSession` 按 sessionId 广播 | **天然支持并发**，无需大改 |
| 前端 | 全局单例 `isStreaming`、`streamingBubble`、`pendingToolBlocks` | 切换会话时直接销毁，不支持后台生成 |
| 前端 | `handleServerMessage` 对非当前会话的消息直接 `return` 丢弃 | 后台会话的流式数据全部丢失 |
| 前端 | `sendMessage()` 检查 `isStreaming` 全局锁 | 一个会话生成中，所有会话都无法发送 |
| 数据层 | 每条消息实时 `addMessage()` 写 JSONL | **天然支持并发写入**，无需改动 |

### 关键代码位置

- [src/server/index.ts:331-410](src/server/index.ts#L331-L410) — `processChatMessage`，fire-and-forget，无需改动
- [src/server/public/index.html:1034-1055](src/server/public/index.html#L1034-L1055) — 前端全局状态变量
- [src/server/public/index.html:1188-1206](src/server/public/index.html#L1188-L1206) — `selectSession()`，销毁 streaming 状态
- [src/server/public/index.html:1465-1472](src/server/public/index.html#L1465-L1472) — 丢弃非当前会话消息
- [src/server/public/index.html:1900-1916](src/server/public/index.html#L1900-L1916) — `sendMessage()`，全局锁检查

---

## 实施方案

### 第一步：服务端 — 防止同会话重复发送

**文件**: [src/server/index.ts](src/server/index.ts)

在 `handleWebSocketConnection` 的作用域内维护一个 `Set<string>` 记录正在生成的 sessionId：

```typescript
const generatingSessions = new Set<string>();
```

在 `case "chatMessage"` 中增加检查：

```typescript
if (generatingSessions.has(message.sessionId)) {
  sendToClient(client, {
    type: "error",
    message: "Session is already generating",
    sessionId: message.sessionId,
  });
  break;
}
```

在 `processChatMessage` 的 finally 中移除：

```typescript
generatingSessions.add(sessionId);
try { ... } finally { generatingSessions.delete(sessionId); }
```

**改动量**: ~15 行

---

### 第二步：前端 — 会话级流式状态

**文件**: [src/server/public/index.html](src/server/public/index.html)

#### 2.1 定义会话运行时状态结构

将全局单例状态改为 `Map<string, SessionRuntimeState>`：

```typescript
// 替换全局变量
const sessionStates = new Map(); // sessionId -> SessionRuntimeState

function getSessionState(sessionId) {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, {
      isStreaming: false,
      streamingBubble: null,
      streamingReasoningBlock: null,
      pendingToolBlocks: {},
      typingPlaceholder: null,
      latestUsage: null,
    });
  }
  return sessionStates.get(sessionId);
}
```

#### 2.2 改造消息处理 — 后台会话缓冲

对于非当前会话的消息，不再丢弃，而是应用到对应会话的 DOM 缓存中。

**方案 A（推荐）**: 维护一个离屏 DOM 容器，后台会话的流式消息渲染到离屏 DOM，切换时整体挂载。

**方案 B**: 在 sessionState 中缓冲增量数据（chunk 列表），切换时重建 DOM。

推荐方案 A，因为利用了现有 `appendMessage` / `appendChunk` / `appendToolCallBlock` 等 DOM 操作逻辑。

具体做法：

```typescript
// 每个会话维护一个离屏消息容器
const offscreenContainers = new Map(); // sessionId -> HTMLElement

function getOffscreenContainer(sessionId) {
  if (!offscreenContainers.has(sessionId)) {
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.appendChild(container);
    offscreenContainers.set(sessionId, container);
  }
  return offscreenContainers.get(sessionId);
}
```

`handleServerMessage` 改为：

```typescript
function handleServerMessage(msg) {
  // 确定目标会话的消息容器
  const targetSessionId = msg.sessionId;
  if (!targetSessionId) { /* 无会话消息正常处理 */ return; }

  // 如果消息属于当前会话，用主 messagesEl 渲染
  // 如果属于后台会话，用离屏容器渲染
  const isCurrent = targetSessionId === currentSessionId;
  const prevMessagesEl = messagesEl;
  if (!isCurrent) {
    messagesEl = getOffscreenContainer(targetSessionId);
  }

  // ... 原有 switch 逻辑不变，操作 messagesEl 和 sessionState ...

  messagesEl = prevMessagesEl; // 恢复

  // 更新会话列表中的生成状态指示器
  updateSessionListIndicators();
}
```

#### 2.3 改造 selectSession — 保存/恢复状态

```typescript
function selectSession(id) {
  // 保存当前会话的 DOM 状态（如果正在生成中）
  if (currentSessionId && currentSessionId !== id) {
    const state = getSessionState(currentSessionId);
    if (state.isStreaming) {
      // 保存离屏容器的内容引用，供后续恢复
      saveOffscreenDOM(currentSessionId);
    }
  }

  currentSessionId = id;
  const state = getSessionState(id);

  // 恢复该会话的状态
  if (state.isStreaming) {
    // 从离屏容器恢复 DOM 到主视图
    restoreOffscreenDOM(id);
    // 输入框保持禁用（因为仍在生成中）
    setSendDisabled(true);
  } else {
    setSendDisabled(false);
  }

  renderSessionList();
  renderChatArea();

  // 如果该会话没有在生成中，需要从服务端加载最新消息
  if (!state.isStreaming) {
    joinSession(id); // 触发 sessionLoaded，重新渲染消息
  } else {
    // 直接从离屏 DOM 恢复，不重新加载
    hydrateFromOffscreen(id);
  }
}
```

#### 2.4 改造 sendMessage — 会话级锁

```typescript
function sendMessage() {
  if (!inputEl || !currentSessionId) return;
  const state = getSessionState(currentSessionId);
  if (state.isStreaming) return; // 仅检查当前会话
  // ... 其余不变
}
```

#### 2.5 改造 compactCurrentSession — 会话级锁

```typescript
async function compactCurrentSession() {
  const state = getSessionState(currentSessionId);
  if (state.isStreaming || isCompacting) return;
  // ... 其余不变
}
```

#### 2.6 会话列表生成指示器

在 `renderSessionList` 中，对正在生成的会话显示动画指示器：

```javascript
const state = sessionStates.get(session.id);
const indicator = state?.isStreaming
  ? '<span class="session-generating" title="生成中">●</span>'
  : '';
```

CSS 动画让圆点脉冲。

---

### 第三步：chatEnd 处理 — 后台完成时同步

当后台会话生成完成时：

1. 离屏 DOM 中的内容已经完整
2. 标记 `state.isStreaming = false`
3. 更新会话列表指示器
4. 如果用户正好切换回该会话，恢复输入框

```typescript
case "chatEnd":
  const endState = getSessionState(msg.sessionId);
  endState.isStreaming = false;
  endState.latestUsage = msg.usage;
  // ... 原有 DOM 收尾逻辑
  updateSessionListIndicators();
  if (msg.sessionId === currentSessionId) {
    setSendDisabled(false);
  }
  break;
```

---

### 第四步：DOM 管理 — 离屏渲染与恢复

#### 4.1 离屏渲染

当后台会话收到流式消息时，临时将 `messagesEl` 指向离屏容器，复用现有的 `appendMessage`、`appendChunk`、`appendToolCallBlock` 等函数。这些函数都操作 `messagesEl`，所以只需切换 `messagesEl` 的指向即可。

#### 4.2 切换恢复

两种方式：

**切换回一个正在生成的会话时**：将离屏容器的子节点迁移到主 `messagesEl`，然后将后续流式消息的渲染目标切回主 `messagesEl`。

**切换回一个已完成生成的会话时**：正常 `joinSession` → `sessionLoaded` → `renderMessages`，因为消息已持久化到 JSONL。

#### 4.3 清理策略

- 会话删除时：清理对应的 `sessionState` 和离屏容器
- 生成完成后的离屏容器：保留直到会话切换或页面刷新（以便切换回来时使用）
- 页面加载时不恢复离屏状态（刷新后所有会话都从 JSONL 加载已完成的消息）

---

## 不改动的部分

| 模块 | 原因 |
|------|------|
| `src/chat/index.ts` | 每次调用 `chatStream` 都是独立的 async generator，天然支持并发 |
| `src/session/index.ts` | JSONL 追加写入，`addMessage` 每次独立 `loadSession` → `push` → `saveSession`，多会话并发安全（Node.js 单线程） |
| `src/llm/` | 每次创建独立的 provider 实例，无共享状态 |
| WebSocket 协议 | 现有消息类型已包含 `sessionId`，足够区分 |
| `broadcastToSession` | 已按 sessionId 路由，正确 |

---

## 实现顺序

| 步骤 | 内容 | 预估改动量 | 风险 |
|------|------|-----------|------|
| 1 | 服务端防止同会话重复发送 | ~15 行 | 低 |
| 2 | 前端会话级状态 Map + sendMessage 锁 | ~30 行 | 低 |
| 3 | 前端消息处理支持离屏渲染 | ~60 行 | 中 |
| 4 | selectSession 保存/恢复 | ~50 行 | 中 |
| 5 | 会话列表生成指示器 | ~20 行 | 低 |
| 6 | chatEnd 后台完成同步 | ~15 行 | 低 |

**总计**: ~190 行改动，全部集中在 [src/server/public/index.html](src/server/public/index.html) 和少量 [src/server/index.ts](src/server/index.ts)。

## 验收标准

- [ ] A 会话发送消息后，在生成过程中切换到 B 会话，B 能正常发送和接收消息
- [ ] 切换回 A 会话时，能看到已生成的内容（含工具调用块）
- [ ] 会话列表中对正在生成的会话显示指示器
- [ ] 对正在生成的会话，输入框保持禁用，不能重复发送
- [ ] 对已完成生成的会话，输入框正常可用
- [ ] 刷新页面后，A 会话的完整消息从 JSONL 加载（即使在生成中途刷新）
