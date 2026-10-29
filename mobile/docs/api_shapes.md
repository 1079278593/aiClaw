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

`GET /health` 公开，不带令牌：

| 字段 | 用途 |
|---|---|
| `status` | `"ok"` |
| `authRequired` | 为 true 时连接页必须填写 access token |
| `version` | 服务发版号。NAS 镜像是 `deploy/build.number`；本地直接启动是 `dev` |
| `commit` | 构建该镜像时的 git 短哈希。没有则为空字符串 |
| `accountId` | 当前登录的账号 id，例如 `default`。没有租户上下文时为空字符串 |
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

`GET /api/settings/account` 和 `PUT /api/settings/account` 读写当前账号自己的服务配置。响应不含任何密钥，只含 `configured: true/false`。

| 字段 | 用途 |
|---|---|
| `accountId` | 当前账号 id |
| `providers[]` | `id`、`label`、`configured`、`models[{id,label}]`。顺序为 DeepSeek、千问、智谱 |
| `defaultProvider` / `defaultModel` | 新对话使用的默认模型。保存时必须属于所选服务，且该服务已有密钥 |
| `trilium.baseUrl` / `trilium.configured` | Trilium 地址。`configured` 表示已有 ETAPI 令牌 |
| `tavily.configured` | 网页搜索密钥是否已填写 |

PUT 里密钥字段省略表示不修改，空字符串表示清除。`trilium.token`、`providers.<id>.apiKey`、`tavily.apiKey` 都按这个规则。保存成功返回同一份不含密钥的结构。失败时 `error` 为可读原因。

`POST /api/account/token/rotate` 用当前令牌换一把新的。成功体是 `{ token, accountId }`，`token` 只出现这一次。旧令牌立即失效。当前账号不在 `users.json` 里时返回 400。

同一账号每分钟接口超过 180 次，或新对话超过 30 次，返回 429，`error` 为「请求过于频繁，请稍后再试」。对话超限时 WebSocket 的 `error` 消息使用同一句。

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

## 7. 人物、原文、历史简报与档案

行为见 [capture.md](capture.md)。没有图片落盘接口。`profile.md` 手改用 `PUT /api/documents/content`，且必须保留全部标题；保存时把称呼、昵称、简称写回 `meta.json`。`digest.md` 只有历史简报成功时由服务端写入。

人：

```json
{
  "id": "",
  "name": "",
  "nicknames": [],
  "shortNames": [],
  "createdAt": "",
  "updatedAt": "",
  "organizedAt": ""
}
```

`organizedAt` 没有成功整理过就省略。有值时，它是这次交进去的最后一条原文的 `at`，不是整理完成时的时钟。

`POST /api/people` 的 body 是 `{ name }`。名称空白为 400。与已有称呼、昵称或简称相同则 `{ person, created: false }`。新建 `{ person, created: true }`。

`GET /api/people?sort=recent` 按 `updatedAt` 从新到旧。`sort=name` 按称呼排序。返回 `{ people: [ person ] }`。`preview` 是原文最后一条文字，最多 80 字；没有原文时为「空」。

`GET /api/people/:id` 返回 `{ person, profile, digest }`。`digest` 是历史简报全文。

`GET /api/people/:id/entries?before=&limit=` 按时间轴返回一页原文。`limit` 默认 50。省略 `before` 时返回最新一页。结果 `{ entries, hasMore }`，从早到晚。条目没有 `images`。

`PATCH /api/people/:id` 的 body 是 `{ name?, nicknames?, shortNames? }`。新称呼、昵称或简称与别人冲突时 400，`error` 为「已经有这个人」。

`DELETE /api/people/:id` 成功 `{ ok: true }`。目录不存在时 404，`error` 为「文件不存在或已被删除」。不删除咨询用的会话。

追加文字 `POST /api/people/:id/entries`，JSON body：

| 字段 | 说明 |
|---|---|
| `kind` | `line` 或 `note` |
| `speaker` | `line` 必填，`me` 或 `them`。`note` 不要带 |
| `text` | 必填，可含换行 |

成功 `{ person, entry }`。`entry` 含服务端填的 `id` 和 `at`。

识别 `POST /api/people/:id/recognize`，`multipart/form-data`：`images` 可重复，另有 `provider`、`model`。不写 `chatMessage`。当前模型不是视觉模型时 400，`error` 为「请切换到视觉模型后再识别」，不产生条目。群聊或左侧有两个及以上的人时，这一张失败，`error` 为「这是群聊，不能放进个人对话」。其它失败为「识别失败」。成功的句子只含双方说过的话，按从上到下排列，`speaker` 为 `me` 或 `them`。时间、系统灰字和撤回不产生条目。服务端不保存图片字节。

整理由咨询输入框的「整理」按钮发起，走一轮 `chatMessage`，`captureJob` 为 `organize`，用户可见内容为「整理目前新增的内容。」材料由服务端附在给模型的说明里，不另开隐藏任务。成功后服务端把回复里 `<<<档案>>>` 之前的正文追加进 `digest.md`，并把 `organizedAt` 写成这次最后一条原文的 `at`。该标记之后栏目齐全时写成 `profile.md`。标记之后的文字不进入气泡，也不进入会话记录。失败时两个文件都不改，`organizedAt` 也不动。

`PATCH /api/people/:id/entries/:entryId` 的 body 是 `{ text?, speaker? }`。`at` 和顺序不变。`speaker` 只对 `line` 有效。不改 `digest.md`，也不改 `organizedAt`。

`DELETE /api/people/:id/entries/:entryId` 成功 `{ ok: true }`。不改 `digest.md`，也不改 `organizedAt`。

提问时的 `chatMessage` 额外带：

| 字段 | 说明 |
|---|---|
| `threadPath` | `inputs/people/<id>`。必须是已有的人，否则拒绝。有此字段时改附 [capture.md](capture.md) 第 10 节的系统提示 |
| `captureJob` | 只有「整理」按钮带 `organize`。省略时是普通咨询，完成了也不写 `profile.md` 和 `digest.md` |

正在看原文或历史简报时，`previewPath` 分别为 `inputs/people/<id>/entries.jsonl`、`inputs/people/<id>/digest.md`。选中文字时再带 `selectedPreviewText`。没打开这两份、只是选中了人，不设置 `previewPath`。

## 8. 心得 reflections

根目录：`inputs/reflections/`。首页是文件夹。进入文件夹后才列出该层笔记，按 `updatedAt` 在客户端分成今天、昨天、前 7 天、前 30 天，更早按年份（东八区）。真相源是文件树，无 index。每篇为 Markdown，可选 YAML front matter：`title`、`occurredAt`、`context`、`createdAt`、`updatedAt`。保存更新 `updatedAt`，不改已有 `createdAt`。

### 文内媒体（备忘录式内嵌）

UX：录音和图片插在正文里。界面不展示 `:::aiclaw-audio` 原文。语音是占满一行的圆角卡片：标题「录音」、记录时间、时长、分割线、「听写文本」、最多两行转写，右侧一个播放按钮；点播放后变成倒退 15 秒、播放/暂停、前进 15 秒。原声必留；转写是可改草稿，失败不挡保存。

存储（Obsidian 式 sidecar，不是苹果不透明库）：

```text
inputs/reflections/<folder>/
  散步随想.md
  散步随想.assets/
    20261028T032828Z_a1.m4a
    photo.jpg
```

- sidecar 名 = `«md 主文件名».assets/`。目录树与列表**隐藏** `*.assets`。
- 正文只用相对路径，例如 `./散步随想.assets/photo.jpg`，禁止写死仓库绝对路径。
- `move` / 按日期归夹：同一操作移动 `*.md` + 同名 `*.assets/`（若存在）；相对链接无需改写。
- 删除篇时一并删除对应 `.assets/`。
- 用户在 NAS 上手拖时，md 与 `.assets` 应一起拖。

正文标记：

```markdown
:::aiclaw-audio[id=20261028T032828Z_a1 src="./散步随想.assets/20261028T032828Z_a1.m4a"]
转写草稿（可手改；以原声为准）
:::

![说明](./散步随想.assets/photo.jpg)
```

「拿去问」只带 md 正文（含转写草稿），P0 不把音频送给模型。与人物「可不留音频」策略分离。

| 接口 | 说明 |
|---|---|
| `GET /api/reflections?view=tree` | 目录树。文件节点带 `updatedAt`。心得首页用这个，不用扁平时间序。不含 `*.assets` |
| `GET /api/reflections?q=` | 扫树扁平列表，按 `occurredAt` 降序。心得首页不再调用 |
| `POST /api/reflections` | `{ title, body?, occurredAt?, context?, folder? }`，默认 `folder=inbox` |
| `GET /api/reflections/content?path=` | 单篇 |
| `PUT /api/reflections/content` | 按 path 更新标题和正文；省略的发生时刻、情境保持原值。`.txt` 首次保存转为 `.md` |
| `DELETE /api/reflections?path=` | 删除篇与对应 `.assets/` |
| `POST /api/reflections/parse` | 只解析记事本粘贴，不写盘 |
| `POST /api/reflections/import` | `{ text?\|sourcePath?, folder?, dryRun?, deleteSource? }` 拆篇写入 |
| `POST /api/reflections/mkdir` | `{ folder }` |
| `POST /api/reflections/move` | `{ from, toFolder?\|toPath? }`；成对迁移 sidecar |
| `POST /api/reflections/organize-by-date` | `{ path }` → 移到 `YYYY/MM/`；成对迁移 sidecar |
| `POST /api/reflections/media` | `multipart/form-data`：`path`（篇 md）、`file`、可选 `kind=audio\|image`、`transcript`。写入 sidecar，返回 `{ id, relativeSrc, mediaPath, marker, kind }` |
| `GET /api/reflections/media?path=` | 读取 sidecar 内文件（须在某个 `*.assets/` 下）。需 Bearer（鉴权开启时） |
| `GET /api/reflections/assets?path=` | 本篇 sidecar 文件列表 `{ assets: [{ name, path, kind }] }`，`kind` 为 `audio` / `image` / `other` |
| `GET /api/reflections/orphans` | 无对应 md/txt 的 `*.assets` 目录 `{ orphans: [{ path, stem, folder }] }` |

标题变更且净化后的文件名与当前主名不同时，`PUT /api/reflections/content` 会重命名 `.md`、成对重命名 `.assets`，并改写正文里的 `./旧名.assets/` 前缀。

语音：App 手动开始/结束（备忘录式，不因时长或静音自动停录）。Web 浏览器录音保留约 5 分钟安全上限自动结束，避免标签页长时间占麦。静音自动停更适合「听写会话」，不适合「原声附件」（停顿思考会被误切）。「改转写草稿」只改标记内文字；系统 Speech 不能对已存原声自动重转，云端精转属后续。

拿去问：打开该篇后发 `chatMessage` 带 `previewPath`（路径如 `inputs/reflections/inbox/xxx.md`），不设 `threadPath`。

