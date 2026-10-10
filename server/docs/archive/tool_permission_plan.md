# 工具权限控制规划

## 需求

对写操作（`write`、`edit`）和删除操作（`delete`）加权限开关。开关关闭时，每次操作前弹出 popover 要求用户确认；开关打开时不加限制。默认关闭（即默认需要确认）。

读操作（`list`、`read`、`search`）无需权限控制，始终允许。

---

## 操作分类

| 工具 | 类型 | 受控 |
|------|------|------|
| `list` | 读 | 否 |
| `read` | 读 | 否 |
| `search` | 读 | 否 |
| `write` | 写 | 是 |
| `edit` | 写 | 是 |
| `delete` | 删除 | 是 |

---

## 数据流

```
LLM 决定调用 write/edit/delete
  → 服务端执行前，发送 toolPermissionRequest 消息给前端
  → 前端弹出确认 popover（显示工具名 + 操作摘要）
  → 用户点击"允许"或"拒绝"
  → 前端发送 toolPermissionResponse { requestId, allowed } 给服务端
  → 服务端收到后继续执行（或返回拒绝结果给 LLM）
```

---

## 改动范围

### 1. 前端状态：权限开关

文件：`src/server/public/index.html`

在设置区域加一个"写/删除权限"开关（toggle），状态存 `localStorage`，key 为 `toolWritePermOpen`：
- `true` = 开放（不弹确认）
- `false` = 需确认（默认）

UI 位置：放在现有设置行（模型选择、thinking 等）旁边，或单独一行。

### 2. WebSocket 协议扩展

文件：`src/server/index.ts`

新增两种消息类型：

**服务端 → 客户端**：
```ts
{ type: "toolPermissionRequest"; sessionId: string; requestId: string; toolName: string; summary: string }
```
- `requestId`：唯一 ID，用于匹配响应
- `toolName`：`"write"` / `"edit"` / `"delete"`
- `summary`：操作摘要，由服务端按工具构造：
  - `write`：`{ path, preview }` — 文件路径 + content 前 100 字符
  - `edit`：`{ path, oldPreview, newPreview }` — 文件路径 + old_string/new_string 各前 80 字符
  - `delete`：`{ path }` — 文件路径

**客户端 → 服务端**：
```ts
{ type: "toolPermissionResponse"; requestId: string; allowed: boolean }
```

### 3. 服务端：权限拦截

文件：`src/server/index.ts`

在 `processChatMessage` 里，给 `chat` / `chatStream` 的 `onToolCall` 回调加拦截逻辑：

```
onToolCall(name, input):
  if (name in CONTROLLED_TOOLS && !clientPermOpen):
    发送 toolPermissionRequest
    await 等待客户端响应（Promise + Map<requestId, resolve>）
    if (!allowed): 返回拒绝结果，不执行工具
```

实现方式：
- `pendingPermissions: Map<string, (allowed: boolean) => void>` 存等待中的 Promise resolve
- 收到 `toolPermissionResponse` 时，从 Map 取出对应 resolve 并调用
- 不设超时，一直等待直到用户响应

**注意**：`onToolCall` 目前是同步回调，需要改为 async，或在 `runAgenticLoop` 里改为在执行工具前 await 一个 permission check 函数。

具体方案：在 `executeTool` 调用前插入 permission gate：

```ts
// in runAgenticLoop, before executeTool:
const allowed = await options.checkPermission?.(toolName, input) ?? true;
if (!allowed) {
  // 推入 tool result 消息到会话历史（isError: true），但不发给 LLM
  const denyMessage: Message = {
    id: generateId(),
    role: "tool",
    content: "用户拒绝了此操作",
    timestamp: new Date().toISOString(),
    tool_call_id: toolCall.id,
  };
  extraMessages.push(denyMessage);
  // 发送 toolResult 事件让前端显示为失败
  yield { type: "toolResult", name: toolName, content: "用户拒绝了此操作", isError: true };
  // 终止 loop，extraMessages 会被持久化到会话历史，但不再发给 LLM
  return { extraMessages, finalText: null, accumulatedUsage };
}
```

`checkPermission` 由 server 层注入，内部走 WebSocket 往返。

### 4. chat/chatStream 接口扩展

文件：`src/chat/index.ts`

`ChatOptions` 加：
```ts
checkPermission?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
```

`runAgenticLoop` 在调用 `executeTool` 前 await `checkPermission`，拒绝时：将 tool result 消息（`isError: true`）推入 `extraMessages` 持久化到会话历史，yield `toolResult` 事件让前端显示失败，然后立即 return 终止 loop。`extraMessages` 不再发给 LLM，回到等待用户输入状态。

### 5. 前端：确认 popover

文件：`src/server/public/index.html`

**HTML**（放在 `#composer` 外，body 级别，居中显示）：
```html
<div id="tool-permission-overlay">
  <div id="tool-permission-dialog">
    <div id="tool-permission-title">操作确认</div>
    <div id="tool-permission-summary"></div>
    <div id="tool-permission-actions">
      <button id="tool-permission-deny">拒绝</button>
      <button id="tool-permission-allow">允许</button>
    </div>
  </div>
</div>
```

**CSS**：
- overlay：`position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 200`
- dialog：居中卡片，`min-width: 280px`，圆角，阴影
- 允许按钮：强调色（深米色 `#c8b99a`）；拒绝按钮：普通灰色

**JS**：
- 收到 `toolPermissionRequest` 时，按 `toolName` 渲染不同内容：
  - `write`：显示"写入文件"标题 + 路径 + 内容预览（前100字符，超出显示省略号）
  - `edit`：显示"编辑文件"标题 + 路径 + 替换前/替换后各一行（各前80字符）
  - `delete`：显示"删除文件"标题 + 路径
- 点击"允许"/"拒绝"：发送 `toolPermissionResponse`，隐藏 overlay
- 不支持键盘 Escape 关闭（防止误操作）

**权限开关 UI**：
- 在工具栏或设置区加一个 `<label>` + `<input type="checkbox">` toggle
- label 文字：`写/删除权限`（开启时模型可直接写删，关闭时需确认）
- 状态变化时更新 `localStorage` 并通过 WebSocket 同步给服务端（或服务端每次从消息里读）

**同步方式**：最简单的方案是在每条 `chatMessage` 里带上 `writePermOpen: boolean`，服务端据此决定是否需要 permission gate，避免额外的状态同步消息。

---

## 关键文件

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | 无需改动 |
| `src/tools/types.ts` | 无需改动 |
| `src/chat/index.ts` | `ChatOptions` 加 `checkPermission`；`runAgenticLoop` 加 permission gate |
| `src/server/index.ts` | 新增两种 WS 消息类型；`processChatMessage` 注入 `checkPermission`；`pendingPermissions` Map |
| `src/server/public/index.html` | 确认 popover HTML/CSS/JS；权限开关 UI；`chatMessage` 带 `writePermOpen` |

---

## 边界情况

| 情况 | 处理 |
|------|------|
| 用户长时间未响应 | 一直等待，直到用户点允许或拒绝 |
| 用户拒绝 | loop 立即终止，前端工具调用显示为失败，回到等待用户输入状态 |
| 权限开关开启时 | `checkPermission` 直接返回 `true`，不发 WS 消息 |
| 多个工具调用同时触发 | 串行等待（agentic loop 本身是串行的，不会并发） |
| 会话切换时有未响应的 permission | 保持等待，用户切回后仍可响应 |

---

## 暂不做

- 按工具粒度单独开关（只做写/删除统一开关）
- 权限记忆（"本次会话始终允许"）
- 操作日志/审计

---

## 验证点

1. `pnpm build` 无 TS 错误
2. 默认状态（开关关闭）：模型调用 `write` 时弹出确认框，点允许后正常写入
3. 点拒绝后，会话历史里有 tool result 失败消息，前端显示工具调用失败，回到等待用户输入状态，LLM 不再收到任何消息
4. 开关打开后：模型调用 `write`/`edit`/`delete` 不弹框，直接执行
5. 读操作（`list`/`read`/`search`）始终不弹框
