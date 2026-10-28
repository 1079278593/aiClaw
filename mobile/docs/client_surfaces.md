# 移动端界面与连接

本文规定 Flutter 客户端的连接方式、当前要做的界面，以及下一阶段界面的固定行为。会话生成中的状态机见 [session_runtime.md](session_runtime.md)。上下文如何裁剪、消息如何落盘由服务端负责，见仓库 [docs/conversation_control_logic.md](../../server/docs/conversation_control_logic.md)。客户端不截断历史，也不在本地跑 agent loop。

## 1. 当前实现范围

只做一条导航栈：会话列表 → 聊天。设置从会话列表进入。

连接页收集 Base URL 与 accessToken，写入系统安全存储。

1. `GET /health`。响应含 `authRequired`。
2. `authRequired` 为 false 时，token 可空，直接进入会话列表。
3. `authRequired` 为 true 时，后续 `/api/*` 带 `Authorization: Bearer <token>`。用 `GET /api/config` 验证；401 留在连接页。
4. WebSocket 为 `ws(s)://{host}/ws`。基址是 `https` 时用 `wss`。连接后发送 `{ "type": "auth", "token": "<token>" }`，收到 `connected` 才算已连接。关闭码 `4401` 回到连接页并清空错误提示为「凭证无效」。

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
- 「更多」从左栏底部进入，包含主题、字号、字体、推理折叠、写权限、服务与模型、用量和退出。

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
- Flutter Web、合并 `inbox/`、后台长连接。
- 桌面网页的文档工作区保持现在的文档、阅读、聊天。人物工作区按第 4 节加在同一页面里，不另做一套站点。

## 4. 聊天与档案

行为见 [capture.md](capture.md)。手机、iPad、桌面网页是同一套名单。进入一个人之后是原文、历史简报、咨询，只是栏数不同。档案在旁边。

手机底部四项：聊天、人物、文档、更多。原来的会话首页仍是「聊天」，人物是旁边多出来的一块。

- 「聊天」仍是第 2 节的会话列表，点进去是原来的助手会话。
- 「人物」是我和不同人的列表，默认按最近变动排序，可以换成按称呼。按称呼点进去先看档案。按最近变动点进去默认是原文。顶部导航栏是这个人的称呼，可以改，对应的 `id` 不变。右侧气泡是「自己」，左侧是这个人。输入框上方是「自己」开关，旁边可换成自述，还可以选图。图在识别成功后变成句子；群聊、识别失败都不保存。导航栏「历史简报」打开只读摘要，「档案」打开这个人的档案，「咨询」打开当前助手会话并带上这个人。
- 「文档」仍是第 2 节的知识库和目录。助手会话是原来那一套，不按人各建一条。
- 「更多」仍是外观、服务与模型、用量、写权限和退出。

宽屏 iPad 和桌面网页用工作区切换，不用底部四项：

- 「文档」工作区就是第 2 节的三栏，桌面网页则是现有的三栏。这是原来的首页。
- 「人物」工作区：左栏全部的人，可换成按称呼，也就是档案库；中栏默认是原文，可换成历史简报或档案。历史简报没有输入和修改。右栏是咨询，上方标明要带上谁的档案。换人不换会话。两条分隔可拖动，宽度单独记住，不占用文档工作区的宽度。切回「文档」后，原来的首页还在。
- iPad 竖屏左栏是名单，右栏一次显示原文、历史简报、档案或咨询中的一个。

历史简报页只阅读。桌面在原文或历史简报上用鼠标选中文字，手机长按选中，下一条咨询带上这段，并可以按现有写文件方式修改。咨询输入框上有「整理」。选中了人，且上次整理的末尾之后还有原文时，按钮可点。点下去咨询里按平常对话出现这一轮，历史简报页在成功后显示这次回复。原文页的输入框负责一句、自述、相册和语音转写。桌面网页的原文输入框另外接受粘贴图片，粘贴后立刻识别。`@`、`/`、截断和压缩只在咨询输入框。
