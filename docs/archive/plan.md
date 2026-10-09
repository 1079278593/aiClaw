# aiClaw 开发计划

## 开发原则

- **渐进增强** - 从核心功能开始，逐步添加复杂特性
- **每阶段可运行** - 每个阶段结束时都能运行并验证功能
- **向后兼容** - 数据结构和 API 设计考虑后续扩展

---

## 阶段 0：项目初始化

### 目标
搭建基础开发环境和项目结构

### 任务
- 初始化项目（TypeScript + Node.js）
- 配置开发工具（ESLint、Prettier、oxlint、oxfmt）
- 创建基础目录结构
- 配置 Vitest 测试框架
- 设置 pnpm 脚本
- **基础日志系统**（console + 简单级别）
- **基础错误处理**（try-catch + 错误日志）

### 产出
- 可运行的项目骨架
- 测试框架可用
- 日志和错误处理基础设施
 
---

## 阶段 1：基础对话（最小可用版本）

### 目标
实现最简单的对话功能，无记忆、无工具、无知识库

### 核心功能
- 配置系统（`$AICLAW_DATA_DIR/config.json`，API Key 直接存储）
- 用户数据目录初始化（`$AICLAW_DATA_DIR/`）
- 配置验证（启动时检查，错误时清晰提示）
- LLM 提供商接口（智谱/阿里百炼/OpenRouter 任选其一）
- LLM 调用错误处理与重试
- 会话管理（创建、切换、列表）
- 消息存储（JSONL 格式，存储在 `$AICLAW_DATA_DIR/conversations/`）
- Web 界面基础（消息收发、会话列表）
- **文件日志**（写入 `$AICLAW_DATA_DIR/logs/` 目录）

### 技术要点
- WebSocket 通信
- JSONL 消息存储格式
- 简单的会话切换逻辑

### 验收标准
- 能发送消息并收到回复
- 能创建和切换会话
- 刷新页面后消息不丢失
- API 失败时自动重试
- 日志可查询

### 暂不实现
- memory.md 自动加载
- 工具调用
- 知识库

---

## 阶段 2：工具系统

### 目标
添加工具调用能力，让 AI 能执行操作

### 核心功能
- 工具定义接口（schema + handler）
- 工具调用协议
- 文件工具（read、write、edit）
- 文件系统安全限制（`fs.allowedDirs`，基于 `$AICLAW_DATA_DIR/`）
- 最大工具调用次数限制（`agent.maxToolCalls`）

### 技术要点
- 工具 schema 定义（参考 Google-Antigravity 规范）
- 工具执行沙箱
- 路径安全校验

### 验收标准
- AI 能读取文件内容
- AI 能写入和编辑文件
- 文件操作受 `fs.allowedDirs` 限制，默认只能访问 `$AICLAW_DATA_DIR/inputs/`、`$AICLAW_DATA_DIR/knowledge_base/`

### 暂不实现
- 网络工具（web_search、web_fetch）
- memory.md 自动加载
- 知识库

---

## 阶段 3：记忆系统（重新设计）

### 目标
添加全局记忆文件，让 AI 能跨会话记住用户信息

### 核心功能
- 全局 `memory.md` 文件（`$AICLAW_DATA_DIR/memory.md`）
- 每次对话自动加载 `memory.md` 到 system prompt
- AI 使用普通 `write`/`edit` 工具维护 `memory.md`

### 技术要点
- 类似 CLAUDE.md 的 always-load 机制
- 无需 embedding、向量数据库、切片

### 验收标准
- 每次对话 AI 能读到 memory.md 内容
- AI 能根据对话自行更新 memory.md
- 重启后记忆依然有效

---

## 阶段 4.1：Token 统计 + Thinking 开关

### 目标
Token 使用可见，Thinking 可控

### 核心功能
- 会话删除
- **Token 计数显示**：每轮对话后在 UI 显示本次调用的 input + output token 数（来自 LLM usage 字段），让用户判断是否需要压缩
  - 抽象层：`UsageRecord { model, provider, inputTokens, outputTokens, timestamp }`
  - 每次 LLM 调用后记录，通过 `chatEnd` 消息传给前端
- **Token 累计统计持久化**：将每次调用的 usage 追加写入 `$AICLAW_DATA_DIR/files/usage.jsonl`，按模型/供应商分组统计
  - 可在界面统计页面查看各模型累计消耗
- **Thinking 开关**：UI 上可切换是否启用 thinking，切换仅影响当前会话，不持久化，刷新页面后恢复 config.json 默认值
  - `enableThinking` 已在 `AgentConfig` 中，前端通过 `GET /api/config` 读取默认值

### 验收标准
- 每轮对话后显示本次 input + output token 数
- Token 使用数据持久化，重启后保留，可在统计页面按模型查看
- UI 上可切换 thinking 开关，切换仅影响当前会话，刷新页面后恢复 config.json 默认值

---

## 阶段 4.2：手动会话压缩

### 目标
让用户可以手动压缩过长的会话历史

### 核心功能
- **手动会话压缩**：用户点击压缩按钮，将历史对话用 LLM 压缩为摘要
  - 原始 `.jsonl` 归档到 `conversation_archive/<sessionId>_<timestamp>.jsonl`
  - 新会话文件 = 仅一条摘要消息（`user` + `assistant` 对，user 说"请回顾之前的对话"，assistant 回复摘要内容）
  - 压缩模型可独立配置（`compaction.model`）
  - 压缩提示词：`$AICLAW_DATA_DIR/files/prompts/compaction_prompt.txt`，不存在时使用内置默认值

### 验收标准
- 点击压缩按钮后，原始文件归档，会话文件替换为压缩版本
- 压缩后 LLM 上下文仅包含摘要消息

---

## 阶段 5：UI 美化

### 目标
使用专业 UI 库重构界面

### 核心功能
- 引入 shadcn/ui 或同类组件库
- 重构聊天界面、会话列表、工具调用展示

### 验收标准
- 界面美观，风格统一

---

## 阶段 6：知识库

### 目标
添加外部知识库支持，使用 LLM 维护索引，无需向量数据库

### 核心功能
- 知识库管理（创建、删除知识库目录）
- 用户将文件放入 `inputs/`，AI 读取后整理到对应知识库，更新 index.md 和 knowledge_index.md
- 可在页面统计页面总览目前的知识库

### 技术要点
- `knowledge_base/index.md`：全局索引，列出所有知识库名称和简介
- `knowledge_base/base1/index.md`：每个知识库的局部索引，介绍该库内容和文件列表
- AI 先读 `knowledge_base/index.md` 选择相关知识库，再读对应的 `index.md`，最后按需读具体文件
- 无需专用搜索工具，全部用普通 `read` 工具

### 验收标准
- 能创建知识库并添加文件
- 用户将文件放入 inputs/ 后，AI 能读取并整理到知识库，更新索引
- AI 能通过两层索引定位并读取知识库内容

---

## 阶段 7：多模型支持

### 目标
支持更多 LLM 提供商

### 核心功能
- 智谱集成
- 阿里百炼集成

### 验收标准
- 能实时切换不同提供商
- 能实时切换不同模型

---

## 阶段 8：用户体验优化

### 目标
完善 Web 界面和交互

### 核心功能
- 发送中状态：发送后禁用输入框/按钮 + 打字动画（三点跳动，圆点用 --text2），回复完成后恢复
- 错误统一进聊天流：所有错误（WebSocket 断开、压缩失败等）统一用 showError() 插入聊天流
- Compact 确认弹框：点击 Compact 按钮弹出自定义确认框（风格与 Token Stats / Knowledge Base 弹框一致），替换浏览器原生 confirm()
- 按钮 hover 去蓝：toolbar 按钮（Token Stats、Compact 等）hover 改为 border-strong 沙色边框 + bg2 背景，去掉蓝色

### 跳过
- WebSocket 降级到 HTTP 轮询（已有 3 秒自动重连，够用）
- 响应式布局（仅桌面使用）

### 验收标准
- 发送消息后有明确的等待状态，不会误以为卡死
- 任何失败都有聊天流内提示，不用 alert()
- Compact 确认框风格统一，不用浏览器原生弹框
- toolbar 按钮 hover 无蓝色，改为沙色边框
---