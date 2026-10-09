# aiClaw - 个人本地知识库AI助手

## 项目信息
- **平台**：Windows 11 —— 使用 Windows 路径（反斜杠），而非 `/mnt/c/...`
- 启动服务器：`pnpm build && node dist/cli/index.js start`
- 运行测试：`pnpm test --run`

## 架构
项目架构、模块职责、API 路由、数据格式，参见 [docs/architecture.md](docs/architecture.md)

## 关键入口
- 配置结构与默认值：`src/config/schema.ts`、`templates/config.json`
- 数据目录路径与初始化：`src/config/paths.ts`、`src/config/index.ts`、`src/config/init-strategies.ts`
- HTTP / WebSocket 服务：`src/server/`
- 对话与会话持久化：`src/chat/`、`src/session/`
- 前端：`src/server/public/`，使用原生 ES Modules，无前端构建工具。
- 测试文件通常与源码同目录，命名为 `*.test.ts`。

## 专项设计
- Provider 配置、模型能力和 thinking 参数：`docs/provider_api.md`
- 对话截断、压缩、系统提示词和上下文控制：`docs/conversation_control_logic.md`
- 多会话切换与生成中状态保留：`docs/session_switch_flow.md`
- 初始化流程、模板与更新策略：`docs/init_method.md`
- Token 用量和费用统计：`docs/token_cost_stats.md`
