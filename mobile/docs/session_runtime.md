# 移动端会话运行时

本文说明手机客户端在多会话同时生成时如何保存状态、如何处理切换、工具权限和 `sessionLoaded`。消息字段见 [api_shapes.md](api_shapes.md)。服务端如何分配 `runId` 见仓库 [docs/session_switch_flow.md](../../server/docs/session_switch_flow.md)。两边的分支必须一致。Flutter 用内存对象代替桌面的 DOM 节点。

## 1. 设计目标

- A、B 等多个会话可以同时生成，互不取消、互不污染当前画面。
- 切走期间收到的文本、推理、工具调用和工具结果切回来仍然在。
- 同一会话的新生成不会被旧生成的迟到事件覆盖。
- 过期的 `sessionLoaded` 不会覆盖用户后来切换到的会话。
- 切换会话不会隐式拒绝待确认的工具权限。

## 2. 运行时对象

每个 `sessionId` 在 `sessionCache` 中有一份 `SessionRuntime`：

| 字段 | 用途 |
|---|---|
| `messages` | 已展示消息。正在生成的助手内容也在这里，不另挂到全局 |
| `isStreaming` | 该会话是否仍在生成 |
| `currentRunId` | 当前接受的运行 |
| `lastSequence` | 该运行已应用的最大 `sequence` |
| `pendingEvents` | 会话不在前台时收到、尚未回放的原始服务端事件 |
| `pendingPermission` | 尚未回答的 `toolPermissionRequest`，没有则为空 |

另外有两个全局量：

- `currentSessionId`：当前画面上的会话
- `sessionLoadRequestId`：最近一次 `joinSession` 发出的 `requestId`

WebSocket 消息只从 `onServerMessage` 进入。界面不直接改另一会话的 runtime。

## 3. 切换

```text
selectSession(B)
  1. 关闭 A 的权限弹层，不发送 toolPermissionResponse
  2. A 的 runtime 留在 sessionCache[A]，含 pendingPermission
  3. 取出或创建 sessionCache[B]
  4. 按到达顺序回放 B.pendingEvents，然后清空该队列
  5. 若 B.pendingPermission 仍在，再显示弹层
  6. 发送 joinSession(B, requestId)，写入 sessionLoadRequestId
```

回放时事件作用于 B 恢复后的 `messages`，不能追加到 A。

## 4. 分发

```text
收到带 sessionId 的事件
  |
  +-- sessionId == currentSessionId
  |     +-- 按第 5 节校验 runId 与 sequence
  |     +-- 通过后更新该 runtime 与当前画面
  |
  +-- sessionId != currentSessionId
        +-- 整包追加到 sessionCache[sessionId].pendingEvents
        +-- 不创建该会话时，先建一份空 runtime 再追加
        +-- 不改当前画面
```

没有 `sessionId` 的 `connected`、`pong`、全局 `error` 只作用于连接状态，不写入某个会话的 `pendingEvents`。

后台事件不能丢。一次回复可能是「文本 → 工具调用 → 工具结果 → 文本」。若只等下一次 `sessionLoaded`，切回来时本地缓存会和服务端最终快照对不齐。

## 5. 运行与序号

处理某个会话的流事件时：

1. `chatStart` 设置该会话的 `currentRunId`、`lastSequence`，并把 `isStreaming` 设为 true。
2. 其后的 `chatChunk`、`chatReasoning`、`toolCall`、`toolResult`、`toolPermissionRequest`、`chatEnd`、`chatCancelled`，以及带 `sequence` 的 `error`，只有在 `runId` 相同、`sequence` 大于 `lastSequence`、且 `isStreaming` 仍为 true 时才应用。应用后把 `lastSequence` 更新为该 `sequence`。
3. `chatEnd` 与 `chatCancelled` 应用后把 `isStreaming` 设为 false。`chatEnd` 若带 `fullResponse`，助手正文以它为准。带 `sequence` 的 `error` 应用后同样把 `isStreaming` 设为 false，并把 `message` 显示在该会话上。
4. 新的 `chatStart` 之后，旧 `runId` 的迟到事件全部忽略。
5. `error` 有 `sessionId` 但没有 `sequence`：归到该会话（前台直接显示，后台进入 `pendingEvents`），不走序号校验，也不改 `currentRunId`。`error` 没有 `sessionId`：只作连接级提示，不写入任何会话。

WebSocket 保持发送顺序，但不能代替 `runId`。同会话的新请求会中止旧请求，旧请求的清理事件仍可能晚到。

## 6. sessionLoaded

只接受 `requestId == sessionLoadRequestId` 的 `sessionLoaded`。用于挡住：

```text
join A (request 1) -> join B (request 2) -> join A (request 3)
                                  |
                        request 1 的响应迟到
```

通过校验后：

- 该会话 `isStreaming == false`，且快照消息条数与本地 `messages` 不同：用服务端 `messages` 整表替换。
- 该会话 `isStreaming == true`：保留本地 `messages` 与流式块，不用快照覆盖尚未落盘的中间内容。

## 7. 工具权限

未决请求以 `requestId` 为键，并记下 `sessionId`，放在对应 runtime 的 `pendingPermission`。

```text
A 在后台收到 toolPermissionRequest(R1)
  -> 事件进入 A.pendingEvents（A 不在前台时）
  -> 用户切回 A
  -> 回放后显示弹层
  -> 用户允许或拒绝
  -> 发送 toolPermissionResponse(R1)
  -> 清空 A.pendingPermission
```

从 A 切到 B 只隐藏弹层。只有下面三种情况发送响应：

- 用户点了允许或拒绝
- 该会话收到并应用了 `cancelChat` 对应的取消结果（客户端在发送 `cancelChat` 时，对该会话未决权限发送 `allowed: false`）
- 连接被用户主动退出（清凭证）。系统杀掉进程或网络断开时来不及发送，未决请求留在服务端直到超时；重连后以新的 `sessionLoaded` 为准，不补发旧的拒绝

`setWritePermission` 只改变之后的工具是否还要确认，不回答已经弹出的请求。

## 8. 断线与保活

服务端每 30 秒发一次 WebSocket ping 帧，并要求 pong 帧。一个周期内没有 pong 就会断开这条连接。使用会自动回复 ping 帧的实现（Dart `dart:io` 的 `WebSocket` 会）。JSON `{ type: "ping" }` 只会得到 `{ type: "pong" }`，不参与这 30 秒判断。

关闭码 `4401` 不重连，回到连接页。其它原因在前台断开时，3 秒后重连，失败则继续每 3 秒一次。从后台回到前台时若已断开，立刻重连一次，不等这 3 秒。

`pendingEvents` 和半截流式块只在内存中。断线、回到前台之前进程被回收，这些内容没有了。重连后对当前会话 `joinSession`。生成若已在服务端结束，第 6 节会用持久化消息补上最终内容。不要在客户端把流事件写成日志来补这一段。

## 9. 回归场景

状态机单测至少覆盖：

1. A 输出文本时切到 B，B 调用工具并输出，反复切换后 A、B 的文本均完整。
2. A 在后台依次收到 `toolCall`、`toolResult`、`chatChunk`，切回后工具块与结果顺序正确。
3. A 等待权限时切到 B，A 不被自动拒绝；切回 A 后可继续确认。
4. 同一会话取消后立即重新发送，旧运行的迟到事件不影响新运行。
5. 快速 A → B → A 后，旧 `sessionLoaded` 不覆盖最新 A 的状态。
