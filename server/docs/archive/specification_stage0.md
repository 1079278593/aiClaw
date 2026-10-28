# 阶段 0：项目初始化 - 功能规格

## 目标
搭建基础开发环境和项目结构。

## 功能清单

### 1. 项目初始化
- TypeScript + Node.js 项目配置
- package.json 依赖配置
- tsconfig.json 配置

### 2. 开发工具配置
- **ESLint** - 代码检查
- **Prettier** - 代码格式化
- **oxlint** - 快速检查
- **oxfmt** - 快速格式化

### 3. 目录结构
```
aiClaw/
├── src/              # 源代码
├── test/             # 测试文件
├── docs/             # 文档
├── logs/             # 日志文件
├── conversations/    # 会话历史 (JSONL)
├── memory/           # 记忆文件 (Markdown)
├── knowledge/        # 知识库文件
├── files/            # 本地文件工作区
└── database/         # SQLite 数据库
```

### 4. 测试框架
- **Vitest** 配置
- 基础测试脚本

### 5. pnpm 脚本
- `dev` - 开发模式
- `build` - 生产构建
- `test` - 运行测试
- `lint` - 代码检查
- `format` - 代码格式化

### 6. 基础日志系统
- 简单日志级别 (debug, verbose, info, warn, error)
- 控制台输出
- 文件输出到 `./logs/`

### 7. 基础错误处理
- try-catch 模式
- 错误日志记录

## 交付物
- 可运行的项目骨架
- 可用的测试框架
- 日志和错误处理基础设施

## 参考
- 主规格文档: [specifications.md](./specifications.md)
- 架构文档: [architecture.md](./architecture.md)
- 开发计划: [plan.md](./plan.md)
