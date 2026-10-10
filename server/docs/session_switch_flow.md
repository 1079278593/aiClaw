# 会话切换与消息流架构

本文说明多会话并发生成时，前端如何隔离运行时状态、服务端如何标识每次生成，以及如何处理切换、工具调用和权限确认。

## 1. 设计目标

- A、B 等多个会话可以同时生成，互不取消、互不污染渲染状态。
- 用户在会话切换期间不丢失文本、推理、工具调用或工具结果。
- 同一会话的新生成不会被旧生成的迟到事件覆盖。
- 异步 `sessionLoaded` 响应不会覆盖用户随后切换出的当前视图。
- 切换会话不会隐式拒绝待确认的工具权限。

## 2. 服务端职责

服务端按 `sessionId` 持久化会话，并为每一次 `chatMessage` 创建独立的 `runId`。

```text
session A  ── run A-1 ── chatStart / toolCall / chatEnd
session B  ── run B-1 ── chatStart / toolCall / chatEnd
session A  ── run A-2 ── chatStart / ...
```

### 2.1 取消控制

`activeChats` 使用 `Map<sessionId, { controller, runId }>`：

- 取消 A 只中止 A 当前的 controller，不影响 B。
- 新的 A 运行替换旧的 A 运行。
- 旧运行的 `finally` 只会删除仍指向自己的条目，不能误删新运行的 controller。

### 2.2 流事件协议

每个聊天流事件都包含：

| 字段 | 用途 |
|---|---|
| `sessionId` | 事件属于哪个会话 |
| `runId` | 事件属于该会话的哪一次生成 |
| `sequence` | 该运行内单调递增的事件序号 |

适用事件：`chatStart`、`chatChunk`、`chatReasoning`、`toolCall`、`toolResult`、`toolPermissionRequest`、`chatEnd`、`chatCancelled`。

`processChatMessage` 的所有事件均使用 `sendToClient()` 直发给发起请求的 WebSocket 客户端。服务端不根据 `client.sessionId` 过滤聊天事件；它只是用于日志和最近会话记录。

### 2.3 加载会话

客户端发送：

```typescript
{ type: "joinSession", sessionId, requestId }
```

服务端在 `sessionLoaded` 中原样回传 `requestId`。`loadSession()` 是异步操作，所以这个 ID 是必须的：快速 A -> B -> A 切换时，旧的 A 加载响应不能当作最新的 A 加载响应处理。

### 2.4 工具权限

待确认权限以 `Map<requestId, { resolve, sessionId }>` 保存：

- `toolPermissionResponse` 仅 resolve 对应请求。
- `cancelChat(sessionId)` 仅拒绝该会话的待确认请求。
- A 等待确认时，B 仍可继续生成或等待自己的确认。

## 3. 前端会话运行时

前端只有一个当前显示的 DOM，但每个会话必须拥有独立的运行时状态。`sessionCache` 是按 `sessionId` 索引的缓存：DOM 节点用于快速恢复，状态字段用于保证恢复后仍能继续消费事件。

| 字段 | 用途 |
|---|---|
| `childNodes` | 当前会话脱离页面后的消息 DOM 节点 |
| `isStreaming` | 该会话是否仍在生成 |
| `currentRunId` / `lastStreamSequence` | 当前接受的运行及最后处理的事件 |
| `streamingBubble` / `currentTextSegment` | 当前 assistant 气泡和文本段的 DOM 引用 |
| `streamingReasoningBlock` / `pendingToolBlocks` | 推理块和未完成工具调用的引用 |
| `typingPlaceholder` | 打字状态节点 |
| `visibleProcessStep` / `pendingProcessStep` | 过程步骤显示状态 |
| `pendingEvents` | 会话在后台期间收到、尚未回放的事件队列 |
| `currentMessages` / `currentSessionMessageCount` | 最近的服务端消息快照 |

`currentTextSegment` 和过程步骤状态必须随会话保存与恢复。它们曾是全局状态，会导致 A 的文本块在切到 B 后被继续追加，表现为两个会话都停在半截。

### 3.1 切换流程

```text
selectSession(B)
  1. 隐藏当前权限弹窗，但不回复拒绝
  2. 保存 A 的 DOM 和全部流式运行时状态到 sessionCache[A]
  3. 恢复 B 的 DOM 和运行时状态
  4. 回放 sessionCache[B].pendingEvents
  5. 显示 B 尚未处理的权限请求（若有）
  6. 发送 joinSession(B, requestId)
```

过程步骤的延时定时器会在切换前停止。定时器回调捕获的是可变的当前状态；若跨会话继续运行，可能修改错误会话的 DOM。

### 3.2 后台事件队列

`handleServerMessage` 是唯一的消息分发点：

```text
收到带 sessionId 的事件
  |
  +-- sessionId === currentSessionId
  |     +-- 校验 runId 和 sequence
  |     +-- 直接更新当前会话的运行时和 DOM
  |
  +-- sessionId !== currentSessionId
        +-- 追加到 sessionCache[sessionId].pendingEvents
        +-- 不操作当前 DOM
```

后台事件不能丢弃。尤其是一次工具调用可能产生“文本 -> 工具调用 -> 工具结果 -> 文本”的多段回复；只依赖最终 `sessionLoaded` 会使切回中的 DOM 缓存与服务端快照不一致。

切回会话后，事件按收到顺序回放。这样回放使用的是该会话恢复后的 `streamingBubble`、`currentTextSegment` 和 `pendingToolBlocks`，不会追加到另一个会话的节点。

### 3.3 运行与序号校验

当前会话处理流事件时遵循：

1. `chatStart` 设置 `currentRunId` 和 `lastStreamSequence`。
2. 后续事件只有在 `runId` 相同、`sequence` 更大且会话仍处于生成中时才应用。
3. 新运行开始后，旧运行迟到的 `chatCancelled`、`toolResult` 或文本块会被忽略。

WebSocket 能保持发送顺序，但不能替代 `runId`：同会话的新请求会中止旧请求，旧请求的异步清理或网络事件仍可能晚于新请求。

### 3.4 sessionLoaded 校验

前端只接受与 `sessionLoadRequestId` 相同的 `sessionLoaded`。这是用于解决：

```text
join A (request 1) -> join B (request 2) -> join A (request 3)
                                  |
                        request 1 的异步响应迟到
```

如果加载快照与本地缓存消息数不同且会话已经结束，前端使用服务端消息完整重渲染；如果会话仍在生成，保留本地流式状态，避免未落盘的中间块被快照覆盖。

## 4. 工具权限流程

权限请求由 `requestId` 索引，前端 `permissions.js` 保存所有未决请求及其 `sessionId`。

```text
A 后台生成 -> toolPermissionRequest(A, R1)
  -> 事件进入 A.pendingEvents
  -> 用户切回 A
  -> 回放 R1 并展示弹窗
  -> 用户允许或拒绝
  -> toolPermissionResponse(R1)
```

从 A 切到 B 时只隐藏 A 的弹窗，R1 仍保留在未决请求表中。切回 A 时重新展示；只有用户明确选择、会话被取消或连接关闭策略决定时才发送拒绝。

## 5. 边界与恢复

- DOM 缓存是性能优化，不是服务端事实来源。会话完成后的 `sessionLoaded` 仍可用持久化消息纠正视图。
- 当前后台事件队列保存在浏览器内存中。页面刷新或断线重连期间，未持久化的中间流块无法恢复；服务端完成后会话持久化数据会恢复最终内容。
- 若需要断线后也恢复“正在生成”的中间步骤，应将运行事件持久化为带序号的 journal，或提供按 `runId` 获取未确认事件的服务端 API。

## 6. 回归场景

至少覆盖以下场景：

1. A 输出文本时切到 B，B 调用工具并输出，反复切换后 A、B 的文本均完整。
2. A 在后台依次收到 `toolCall`、`toolResult`、`chatChunk`，切回后工具块与结果顺序正确。
3. A 等待权限时切到 B，A 不被自动拒绝；切回 A 后可继续确认。
4. 同一会话取消后立即重新发送，旧运行的迟到事件不影响新运行。
5. 快速 A -> B -> A 后，旧 `sessionLoaded` 不覆盖最新 A 状态。
