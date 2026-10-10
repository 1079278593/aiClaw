# aiClaw - 个人本地知识库AI助手

## 项目信息
- **平台**：Windows 11 —— 使用 Windows 路径（反斜杠），而非 `/mnt/c/...`
- 启动服务器：在 `server/` 执行 `pnpm build && node dist/cli/index.js start`
- 运行测试：在 `server/` 执行 `pnpm test --run`

## 架构
项目架构、模块职责、API 路由、数据格式，参见 [server/docs/architecture.md](server/docs/architecture.md)

## 关键入口
- 配置结构与默认值：`server/src/config/schema.ts`、`server/templates/config.json`
- 数据目录路径与初始化：`server/src/config/paths.ts`、`server/src/config/index.ts`、`server/src/config/init-strategies.ts`
- HTTP / WebSocket 服务：`server/src/server/`
- 对话与会话持久化：`server/src/chat/`、`server/src/session/`
- 前端：`server/src/server/public/`，使用原生 ES Modules，无前端构建工具。
- 移动端：`mobile/`，Flutter 客户端。实现以 `mobile/docs/` 为准。
- 测试文件通常与源码同目录，命名为 `*.test.ts`。

## 专项设计
- Provider 配置、模型能力和 thinking 参数：`server/docs/provider_api.md`
- 对话截断、压缩、系统提示词和上下文控制：`server/docs/conversation_control_logic.md`
- 多会话切换与生成中状态保留：`server/docs/session_switch_flow.md`
- 初始化流程、模板与更新策略：`server/docs/init_method.md`
- Token 用量和费用统计：`server/docs/token_cost_stats.md`
- 多端鉴权 / CORS / WS 凭证：`server/docs/multi_client.md`
- 移动端连接、界面与会话运行时：`mobile/docs/client_surfaces.md`、`mobile/docs/session_runtime.md`
