# 会话控制逻辑说明

本文说明当前项目里“消息如何进入会话、如何发给模型、哪些消息会持久化、哪些不会、特殊 provider/模式如何处理、compact 如何处理图片”等核心逻辑。

目标不是讲 UI 细节，而是讲**对话控制层的真实行为**。

## 1. 核心入口

当前网页聊天主链路是：

1. 前端通过 WebSocket 发送 `chatMessage`
2. 服务端 `processChatMessage()` 做前置校验与组装
3. 调用 `chatStream()`
4. `chatStream()` 读取 session 历史、构造上下文、执行 agent loop
5. 最终把需要持久化的消息写回 session

相关文件：

- `src/server/index.ts`
- `src/chat/index.ts`
- `src/session/index.ts`

## 2. session 里实际存什么

### 2.1 存储格式

每个会话存成一个 `.jsonl` 文件，位于：

- `conversations/<sessionId>.jsonl`

其中包含两类内容：

- 一条内部 metadata 记录
- 多条真实消息记录

metadata 记录是：

- `role: "system"`
- `id: "meta"`
- `metadata.title / createdAt / updatedAt / lastProvider / lastModel`

这条 metadata **不会**出现在用户可见历史里，加载 session 时会被单独解析出来。

相关实现：

- `src/session/index.ts`

### 2.2 会持久化的消息

正常一次对话结束后，session 中可能持久化这些消息：

- `user`
- `assistant`
- `assistant`（带 `tool_calls`）
- `tool`

也就是说，工具调用链本身是会存历史的。

### 2.3 不会持久化的内容

以下内容不会落到 session 历史：

- session metadata 以外的运行态状态
- 服务端伪流式输出过程中的 chunk

### 2.4 reasoning_content 的处理

- provider 返回 reasoning 时，agent loop 内部会保留
- **会完整持久化到磁盘**，前端渲染为折叠的 "Thinking" 块
- 发送给模型时，`sanitizeHistoryForProvider` 对 reasoning_content 不做剥离，所有 provider 的历史 reasoning 都会随消息发送（供多轮上下文参考）

相关实现：

- `src/chat/index.ts`

## 3. 当前一轮聊天如何组装上下文

### 3.1 基础来源

每次发给模型的上下文由三部分组成：

1. system prompt
2. 已保存的会话历史
3. 当前这条 user message

### 3.2 system prompt

system prompt 来源：`files/prompts/agent_system_prompt.txt`（由 `loadSystemPrompt()` 读取），并在末尾实时追加一行当前日期 `今天的日期是YYYY/MM/DD`。

文件不存在或为空时，仍会发送仅含日期行的 system 消息。需要长期记忆的内容直接写进该文件即可。

### 3.3 历史裁剪

历史不是无条件全量发送，而是会先做：

- provider 级清洗
- 再按 `contextMaxTokens` / `contextMaxMessages` 截断

注意当前 token 估算对图片不做真实计算：

- 只统计文本 part
- 图片 part 不参与本地估算

这是当前的简化策略。

## 4. 多模态消息当前怎么存和怎么发

### 4.1 `Message.content` 现在的形态

当前 `Message.content` 可以是：

- `string`
- `MessageContentPart[]`
- `null`

其中 `MessageContentPart[]` 支持：

- 文本 part：`{ type: "text", text: "..." }`
- 图片 part：`{ type: "image_url", image_url: { url, path? } }`

### 4.2 图片可来自用户消息或工具结果

当前有两条图片链路：

- 用户可将剪贴板图片粘贴到对话输入框，作为 user 消息的图片 part 发送。
- 模型可调用 `read` 读取图片（读取 `fs.allowedDirs` 或 `fs.allowedFiles` 范围内的图片）。工具结果会包含文本摘要和图片 part，使模型能在同一轮 agent loop 中查看图片。

`read` 工具按扩展名分流：文本文件返回内容，图片文件（png/jpg/jpeg/gif/webp）返回图片 part。图片分支会依据当前模型的视觉能力（`context.supportsImages`）做门控——非视觉模型调用 `read` 读图片时会得到文本报错而非图片字节。

`read` 读取图片目前支持 PNG、JPG/JPEG、GIF 和 WebP；图片会被转换为 `data:image/...;base64,...` 后发送给模型，而不是发送本地绝对路径。原始图片最大为 5 MiB；若长边超过 1024 像素，会按比例缩小到 1024 像素并编码为 JPEG（质量 85）。长边不超过 1024 像素的图片保留原始格式和字节。

### 4.3 前端图片来源

前端仅支持从剪贴板粘贴图片。对话框中的图片目录选择按钮已移除；模型需要查看允许目录中的图片时，应自行调用 `read`。

## 5. 非视觉模型如何处理图片

### 5.1 当前轮发送前校验

如果用户本次消息带了图片，但当前模型不是 `modal: "vl"`：

- 服务端直接报错
- 不调用模型
- 不写入 session 历史

也就是说，这条消息会被**整条丢弃**。

前端收到错误后：

- 保留输入框文本
- 保留待发图片
- 用户可切换到视觉模型后重发

### 5.2 历史里的旧图片怎么处理

即使旧历史里已经存在图片消息，切到非视觉模型后也不会直接原样带过去。

发送前会做一层历史清洗：

- 如果模型支持图片：历史原样保留
- 如果模型不支持图片：
  - `content` 是字符串：原样保留
  - `content` 是数组：只保留 `text` part，移除 `image_url` part
  - 如果移除后没有任何文本内容：整条消息丢弃

这一步只影响**发给模型的上下文**，不修改 session 文件本身。

## 6. agent loop 里的消息行为

### 6.1 工具调用过程

当前 agent loop 使用的是非流式 `complete()` 循环：

1. 把当前消息发给模型
2. 如果模型返回 `tool_calls`
3. 执行对应工具
4. 把 `assistant(tool_calls)` 和 `tool` 消息加入本轮 `extraMessages`
5. 继续下一次 `complete()`

### 6.2 当轮有效、落盘时清理

`extraMessages` 在当轮内部是完整存在的，包括：

- assistant tool_call 消息
- tool 结果消息
- reasoning_content（如有）

但落盘时：

- reasoning_content **也会持久化**（前端渲染为折叠的 Thinking 块）
- 其余消息照常写入 session

所以：

- 工具调用链会持久化
- reasoning 也会持久化

## 7. `chat()` 和 `chatStream()` 的差异

当前 Web UI 走的是 `chatStream()`。

### 7.1 `chatStream()`

特点：

- 先把 user message 写入 session
- 再执行 agent loop
- 最后把 assistant 最终回复写入 session
- 中间通过伪流式 chunk 发给前端

### 7.2 `chat()`

特点：

- 非流式
- 先跑完整个 agent loop
- 再统一落盘 user / extraMessages / assistant

目前网页聊天主链路基本不会走它。

## 8. 前端看到的历史和 session 里的历史

前端 `sessionLoaded` 拿到的是 session 原始消息。

渲染时：

- 字符串消息按原逻辑显示
- 数组消息会被格式化成文本
  - 文本 part 直接显示
  - 图片 part 显示成路径提示，例如：
    - `[图片] clipboard:image.png`
    - `[图片] inputs/foo.png`

也就是说：

- 历史里图片消息是会保留的
- 但 UI 当前不显示缩略图，只显示路径/来源

## 9. compact 当前怎么做

### 9.1 compact 输入是什么

compact 不是把原始消息数组直接发给模型，而是先把整段历史**序列化成一段纯文本**：

- 每条消息变成：
  - `[role]`
  - `content`
  - 如有 tool_calls，再附加 JSON
  - 如有 `tool_call_id`，再附加对应 id
- 消息之间用 `---` 分隔

### 9.2 compact prompt

compact 使用独立提示词：

- 优先读取 `files/prompts/compaction_prompt.txt`
- 没有就用内置 prompt

compact 发送给模型的是两条消息：

- system：压缩提示词
- user：`<conversation> ... </conversation>` 包裹后的历史全文

### 9.3 compact 如何处理图片

不管 compact 模型本身是否支持图片，当前 compact **一律不处理图片能力**。

统一规则：

- `content` 是字符串：原样保留
- `content` 是数组：只保留 `text` part
- 若一条消息删完图片后已无文本内容，则整条消息丢弃

也就是说 compact 看到的始终是**纯文本历史摘要材料**。

### 9.4 compact 完成后会写回什么

compact 成功后：

1. 原始 session 文件先归档到 `conversation_archive`
2. 当前 session 被替换成仅两条消息：
   - `user`：请回顾之前的对话
   - `assistant`：compact 生成的摘要

所以 compact 是“**归档旧历史 + 用摘要重建会话**”，不是在原历史后追加一条 summary。

## 10. lastProvider / lastModel 如何工作

session metadata 中会记录：

- `lastProvider`
- `lastModel`

更新时机：

- 每次聊天成功结束后

作用：

- 前端重新载入该 session 时，自动恢复上次用的 provider/model

注意：

- 这是 session 级运行态信息
- 不影响消息内容本身

## 11. 当前值得记住的几个结论

### 11.1 会话历史里会存什么

- 会存 user / assistant / assistant(tool_calls) / tool
- **会存** reasoning_content（从历史消息中渲染为折叠的 Thinking 块）

### 11.2 图片消息的真实行为

- 图片可以存进 session 历史
- 但只有视觉模型会真正看到它们
- 非视觉模型发请求前会把历史图片过滤掉

### 11.3 非视觉模型带图发送

- 当前轮直接报错
- 不入库
- 不调用模型

### 11.4 reasoning 与工具链历史

- 不再区分 provider：所有模型的历史 reasoning_content 都随上下文发送（`sanitizeHistoryForProvider` 不剥离）
- compact 对工具链历史无 provider 特判，统一按文本序列化处理

### 11.5 compact

- 永远只处理文本
- 图片一律先过滤
- compact 后当前 session 只保留“回顾请求 + 摘要结果”两条消息

## 12. 后续如果继续演进，建议优先注意的地方

如果后面继续改会话控制逻辑，最容易出问题的是这几处：

- `sanitizeHistoryForProvider()` 是否与 provider 特性保持一致
- 图片消息在“持久化历史”和“请求上下文”之间是否被混淆
- `chat()` 与 `chatStream()` 的落盘时机差异
- compact 是否仍然只处理纯文本
- 前端 optimistic UI 与后端校验失败后的回滚是否一致

建议以后只要改下面任一行为，都同步更新本文：

- session 历史格式
- provider 特殊清洗规则
- 图片消息处理
- compact 输入/输出格式
- 错误回滚逻辑
