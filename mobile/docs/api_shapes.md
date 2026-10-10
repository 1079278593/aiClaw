# 移动端接口与消息形状

本文列出客户端要读、要写的 JSON 字段。会话运行时的分支见 [session_runtime.md](session_runtime.md)。界面放在哪一页见 [client_surfaces.md](client_surfaces.md)。这里不重复那些流程，只规定字段，避免实现时另起名字。

HTTP 失败时读 JSON 的 `error` 字符串。401 回到连接页。下文成功体都不含 `error`。

## 1. 配置与模型选择

`GET /api/config`：

| 字段 | 用途 |
|---|---|
| `availableProviders` | 已配置密钥、可以选择的提供商 id 列表 |
| `providers[id].models` | 该提供商的模型。只展示 `availableProviders` 里的提供商 |
| `defaultProvider` / `defaultModel` / `defaultThinkingEffort` | 会话没有 last* 时的默认值 |
| `triliumEnabled` | 为 true 时文档根增加 `trilium` |
| `authRequired` | 与 `/health` 相同含义 |
| `gitSyncEnabled` | 手机不使用 |

模型对象：

| 字段 | 用途 |
|---|---|
| `id` | 写入 `chatMessage.model` |
| `label` | 界面文案，缺省时显示 `id` |
| `modal` | `"vl"` 表示可发图片；`"l"` 或省略表示不可 |
| `thinking` | `{ id, label?, params }[]`。选择器展示 `label`，没有则展示 `id`。发给服务端的是 `id` |
| `thinkingOff` | 字段存在（可以是空对象）时，选择器最前面增加一项 `{ id: "off", label: "off" }`。不要自己再发明 `"none"` |

思考档位只来自当前模型的 `thinking` / `thinkingOff`，不使用写死的档位列表。切换模型后，若当前 `thinkingEffort` 不在新列表里，改成该模型的第一项；列表为空则沿用 `defaultThinkingEffort`。

`modal` 不是 `"vl"` 时，不把 `images` 放进 `chatMessage`。服务端会回 `error`：「当前模型不支持图片，请切换到视觉模型后再发送」。这条 `error` 只有 `sessionId`，没有 `runId`。

## 2. 会话列表

`GET /api/sessions` 返回 `{ sessions }`。`POST /api/sessions` 的 body 是 `{ title? }`，返回 `{ session }`。标题省略时由服务端命名。

`PATCH /api/sessions/:id` 的 body 是 `{ title }`，`title` 不能为空，返回 `{ session }`。`DELETE /api/sessions/:id` 返回 `{ ok: true }`。

列表只使用每项的 `id`、`title`、`updatedAt`。响应里虽有 `messages`，列表界面不渲染它们。进入聊天后的历史只来自 `sessionLoaded`。

`GET /api/app-state` 返回 `{ lastActiveSessionId? }`。客户端只读。上次会话由服务端在 `joinSession` 成功时写入，客户端不另发保存请求。

## 3. 历史消息

`sessionLoaded.session.messages` 的元素：

| 字段 | 用途 |
|---|---|
| `id` | 消息 id。从此重开时作为 `messageId` |
| `role` | `user`、`assistant`、`tool`。`system` 且 `id == "meta"` 的记录服务端已去掉，客户端若仍见到则跳过 |
| `content` | `string`、`null`，或片段数组 |
| `reasoning_content` | 助手已落盘的推理文本。有则画在正文之前 |
| `tool_calls` | 助手消息上的调用列表 |
| `tool_call_id` | `role == "tool"` 时，对应某次 `tool_calls[].id` |
| `timestamp` | ISO 时间 |

片段数组的元素：

- `{ type: "text", text }`：普通文字
- `{ type: "image_url", image_url: { url, path? } }`：图片

图片怎么显示：

- `url` 以 `data:` 或 `http://` 或 `https://` 开头：直接显示
- 否则有 `path`：`GET /api/image?path=`，带 Bearer，响应对图片字节

`tool_calls[]` 的元素是 `{ id, type: "function", function: { name, arguments } }`。`arguments` 是 JSON 字符串，解析失败就原样显示。紧随其后的 `role == "tool"` 且 `tool_call_id` 相同的消息是这次调用的结果；`content` 为字符串。结果画在对应调用下面，不单独当成一条用户对话。

流式事件落成的助手气泡与上面同一套：`chatReasoning` 累积为推理，`chatChunk` 累积为正文，`toolCall` / `toolResult` 用 `callId` 配对。`chatEnd.fullResponse` 若存在，用它替换该次运行的正文，不替换推理和工具块。

## 4. 发送

`chatMessage`：

```json
{
  "type": "chatMessage",
  "sessionId": "",
  "content": "",
  "provider": "",
  "model": "",
  "thinkingEffort": "",
  "images": [{ "url": "", "path": "" }],
  "previewPath": "",
  "selectedPreviewText": ""
}
```

`provider`、`model` 必填。`thinkingEffort` 按第 1 节选择。`images`、`previewPath`、`selectedPreviewText` 没有就省略整个字段，不送空字符串。相册图片、附带文档和选区由界面按 [client_surfaces.md](client_surfaces.md) 第 2 节填入。

当前会话 `isStreaming == true` 时，发送控件改为取消，发出 `{ type: "cancelChat", sessionId }`，不再发第二条 `chatMessage`。

## 5. 重开与压缩

`POST /api/sessions/:id/truncate`，body `{ messageId }`。`messageId` 是该条用户消息的 `id`。成功 `{ ok: true, messageCount }`。然后对该会话重新 `joinSession`。

`POST /api/sessions/:id/compact`，body `{ keepRecentRounds }`。`keepRecentRounds` 是非负整数，表示保留最近几轮。成功 `{ ok: true, archivedAs }`。然后重新 `joinSession`。

两者失败都保留当前画面，并显示 `error`。

## 6. 文件、命令、文档、知识库、用量

`GET /api/files?q=` 返回 `{ files: [{ path, source, name? }] }`。插入输入框的是 `path`。

`GET /api/commands?q=` 返回 `{ commands: [{ name, prompt }] }`。插入输入框的是 `name`。`prompt` 不插入。

`GET /api/documents/tree?path=` 返回 `{ path, entries: [{ name, path, kind }] }`。`kind` 为 `directory` 或 `file`。目录继续请求树，文件打开内容。根路径分别是 `knowledge_base`、`inputs`，以及 `triliumEnabled` 时的 `trilium`。

`GET /api/documents/content?path=` 返回 `{ path, title?, content, supported, kind }`。`kind` 为：

- `text`：`content` 是正文。非 `trilium:` 路径可编辑，保存用 `PUT /api/documents/content`，body `{ path, content }`，成功 `{ ok: true }`
- `image`：`content` 是 data URL，只预览
- `unsupported`：显示 `content` 里的短句，不提供编辑

路径以 `trilium:` 开头时一律不显示保存。404 时关闭该篇，提示「文件不存在或已被删除」。

`GET /api/knowledge` 返回 `{ bases: [{ name, description, files }] }`。点进一项时打开文档树路径 `knowledge_base/{name}`。`files` 只是该库下的文件名，不是完整路径。

`GET /api/usage/daily?days=` 返回数组，元素为 `{ date, totalTokens, totalCost, byModel, byProvider, byModelCost, byProviderCost }`。后四个是「名字 → 数字」。

`GET /api/usage/stats` 返回数组，元素含 `provider`、`model`、`inputTokens`、`outputTokens`、`billingOutputTokens`、`cost`，以及可选的 `cachedReadTokens`、`cachedWriteTokens`、`thinkingTokens`。

`POST /api/usage/flush` 无 body，成功后重新请求上面两个接口。
