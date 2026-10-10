# 移动端界面与连接

本文规定 Flutter 客户端的连接方式、当前要做的界面，以及下一阶段界面的固定行为。会话生成中的状态机见 [session_runtime.md](session_runtime.md)。上下文如何裁剪、消息如何落盘由服务端负责，见仓库 [docs/conversation_control_logic.md](../../server/docs/conversation_control_logic.md)。客户端不截断历史，也不在本地跑 agent loop。

## 1. 当前实现范围

只做一条导航栈：会话列表 → 聊天。设置从会话列表进入。

连接页收集 Base URL 与 accessToken，写入系统安全存储。

1. `GET /health`。响应含 `authRequired`。
2. `authRequired` 为 false 时，token 可空，直接进入会话列表。
3. `authRequired` 为 true 时，后续 `/api/*` 带 `Authorization: Bearer <token>`。用 `GET /api/config` 验证；401 留在连接页。
4. WebSocket 为 `ws(s)://{host}/ws?access_token=<token>`。基址是 `https` 时用 `wss`。关闭码 `4401` 回到连接页并清空错误提示为「凭证无效」。

平台：

- Android 允许明文 HTTP。iOS ATS 允许局域网 HTTP。
- 模拟器访问电脑：Android 使用 `10.0.2.2`，iOS 模拟器使用 `127.0.0.1`。
- 真机使用电脑局域网 IP。服务 `host` 必须是非 loopback，且 `accessToken` 非空，否则服务端拒绝启动。见 [docs/multi_client.md](../../server/docs/multi_client.md)。
- 进入后台后连接可以断开，不做保活。回到前台后的重连、ping 帧和未落盘流式块见 [session_runtime.md](session_runtime.md) 第 8 节。

会话列表使用 `GET/POST/PATCH/DELETE /api/sessions`。启动后读 `GET /api/app-state`，若有 `lastActiveSessionId` 则进入该会话。

发送 `chatMessage` 时必须带 `provider`、`model`、`thinkingEffort`。已加载会话优先用 `sessionLoaded.session` 的 `lastProvider`、`lastModel`、`lastThinkingEffort`；缺省用 `GET /api/config` 的 `defaultProvider`、`defaultModel`、`defaultThinkingEffort`。聊天页可以改这三项，改动只影响之后发出的消息。

Dart 模型从第一天包含协议里的可选字段 `images`、`previewPath`、`selectedPreviewText`（见 [src/server/protocol.ts](../../server/src/server/protocol.ts)）。填写方式见第 2 节。

写权限：连接建立后默认视为关闭（服务端 `writePermOpen` 初始为 false）。设置页开关发送 `{ type: "setWritePermission", enabled }`。单次工具确认见 session_runtime。

回复正文用 Markdown 渲染，含代码块。推理与工具块在当前阶段始终展开。历史消息和流式气泡的字段见 [api_shapes.md](api_shapes.md) 第 3 节。当前会话正在生成时，发送控件改为取消。

模型列表、思考档位、会话列表字段见 [api_shapes.md](api_shapes.md) 第 1、2 节。思考档位不写死。

## 2. 下一阶段界面

手机用底部三栏：聊天、文档、更多。设置、用量和外观在「更多」。聊天栈仍是列表 → 对话，不改 session_runtime 的分发规则。

平板（短边 ≥ 600）不用底部三栏，按 iPad 的分栏来排，信息架构仍接近桌面网页的「文档 | 阅读 | 聊天」：

- 宽 ≥ 1000：左栏是文档（知识库 / 目录），中间是正在读的文档，右边是聊天。会话不占第四栏，从聊天栏的「历史」打开。左栏与阅读区之间、阅读区与聊天之间各有一条分隔，可以左右拖动。拖完的宽度记在本机。
- 更窄的竖屏：左栏在「会话」和「文档」之间切换，右侧是当前会话或正在读的文档。左栏宽度同样可以拖动并记住。
- 「更多」从左栏底部进入，包含主题、字号、字体、推理折叠、写权限、用量和退出。

手机底部三栏不因为平板布局而改变。

### 2.1 图片

- 从系统相册选择，编码为 data URL，放入 `chatMessage.images`，元素形如 `{ url, path? }`。
- 历史消息里 `image_url.path` 用 `GET /api/image?path=` 拉取，请求带 Bearer。
- 不从剪贴板读图片。

### 2.2 `@` 与 `/`

- 输入 `@` 后请求 `GET /api/files?q=`，选中项把路径插入输入框。
- 输入 `/` 后请求 `GET /api/commands?q=`，选中项插入命令名。
- 候选列表盖在键盘上方。点列表外区域关闭，不插入。

### 2.3 重开与压缩

- 用户消息长按「从此重开」：`POST /api/sessions/:id/truncate`，body 为 `{ messageId }`，成功后对该会话重新 `joinSession`。
- 聊天菜单「压缩」：用户选择保留轮数，`POST /api/sessions/:id/compact`，body 为 `{ keepRecentRounds }`，成功后重新 `joinSession`。
- 失败时保留当前画面，并展示接口返回的 `error`。字段见 [api_shapes.md](api_shapes.md) 第 5 节。

### 2.4 用量

在「更多」中请求：

- `GET /api/usage/daily?days=`
- `GET /api/usage/stats`
- `POST /api/usage/flush`

展示按日列表和汇总数字。不画桌面端那类图。

### 2.5 外观

只存本机，不写服务器。

- 主题取值 `light`、`daylight`、`monochrome`。
- 字号为滑杆。
- 「展开推理与工具过程」关闭时，数据仍留在 runtime 里，界面默认折叠。
- 字体只有系统无衬线和衬线。不打包楷体或宋体文件。

### 2.6 文档与知识库

「文档」栏顶部分段为「知识库」和「目录」。

- 知识库：`GET /api/knowledge`。点一项后打开文档树路径 `knowledge_base/{name}`。
- 目录：`GET /api/documents/tree?path=`。根为 `knowledge_base`、`inputs`。`triliumEnabled` 为 true 时增加 `trilium`。`kind == directory` 继续展开，`kind == file` 打开内容。
- 一次只打开一篇。`kind == text` 且路径不是 `trilium:` 才可 `PUT` 保存。`kind == image` 只预览。`kind == unsupported` 只显示返回的短句。字段见 [api_shapes.md](api_shapes.md) 第 6 节。
- 内容接口返回 404 时关闭该篇，提示「文件不存在或已被删除」。不把文件系统错误原文铺满屏幕。
- 不做多标签，不做源文件行号映射。

附带上下文使用与服务端 [src/server/services/chat-content.ts](../../server/src/server/services/chat-content.ts) 相同的字段：

- 「附带当前文档」开关默认关，存在本机。
- 开关打开且当前有打开的文档时，下一条 `chatMessage` 带 `previewPath`。
- 预览中长按选中文字后出现「附加选区」。下一条再带 `selectedPreviewText`，内容只是选中的原文，不写行号。
- 发送成功后清除选区。开关保持原状态。
- 开关关闭时，两个字段都不发送。

## 3. 不做

- Git 同步。`host` 非 loopback 时 [src/server/routes/git-sync.ts](../../server/src/server/routes/git-sync.ts) 对 `/api/git/*` 返回 404。只在电脑上打开的桌面页使用。
- Flutter Web、改 `server/src/server/public/`、合并 `inbox/`、后台长连接、桌面左右分栏。
