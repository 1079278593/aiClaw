# 数据目录说明

## 概述

aiClaw 使用独立的数据目录存储所有用户数据，与项目代码分离。

**重要**：现在必须通过 `.env` 文件配置 `AICLAW_DATA_DIR`，没有硬编码的默认值。

## 目录位置

### 正式环境

通过项目根目录的 `.env` 文件配置：

```bash
# .env
AICLAW_DATA_DIR=C:\Virtual_D\aiClaw
```

**Windows 推荐路径:**
```
C:\Virtual_D\aiClaw\
```

**Linux/macOS 推荐路径:**
```
~/.aiclaw/
```

### 测试环境

测试自动使用项目根目录下的固定测试目录：

```
./test-data/
```

这个目录：
- 由 `vitest.config.ts` 自动配置
- 在 `.gitignore` 中，不会提交到 git
- 每次测试运行前清理
- 可以手动检查测试结果和配置

## 目录结构

```
C:\Virtual_D\aiClaw\
├── config.json          # 配置文件
├── logs/                # 日志文件
│   └── aiclaw-YYYY-MM-DD.log
├── conversations/       # 会话数据
│   └── {sessionId}.json
├── memory/              # 记忆文件
│   └── {会话标题}/
│       └── memory_YYYY_MM_DD_{slug}.md
├── knowledge/           # 知识库（暂未实现）
├── files/               # 用户文件
│   └── prompts/
│       ├── agent_system_prompt.txt
│       └── memoryPrompt.txt
└── database/            # 向量数据库
    └── memory.db
```

## 配置方式

### 必需配置：.env 文件

**重要**：现在 `.env` 文件是必需的，没有默认值。

在项目根目录创建 `.env` 文件：

```bash
# .env
AICLAW_DATA_DIR=C:\Virtual_D\aiClaw
```

为什么使用 `.env` 文件：
- 配置持久化保存
- 不会意外提交到 git（.env 已在 .gitignore 中）
- 团队成员可以有自己的本地配置
- 测试和正式环境完全分离

### 测试环境配置

测试环境通过 `vitest.config.ts` 自动配置，无需手动设置：

```typescript
// vitest.config.ts
process.env.AICLAW_DATA_DIR = path.join(process.cwd(), ".test-data");
```

测试代码中使用：

```typescript
import { getUserDataDir, getPaths } from "../config/paths.js";

// 获取测试数据目录（自动读取环境变量）
const testDataDir = getUserDataDir(); // 返回 .test-data
const paths = getPaths(testDataDir);

// 使用测试目录
await initConfig(testDataDir);
```

## 开发建议

### 目录结构

```
aiClaw/
├── .env                    # 正式环境配置（指向 C:\Virtual_D\aiClaw）
├── .test-data/             # 测试数据目录（自动创建，gitignore）
│   ├── config.json         # 测试环境配置
│   ├── logs/
│   ├── conversations/
│   └── ...
├── vitest.config.ts        # 测试配置（设置 .test-data）
└── src/
```

### 工作流程

1. **日常开发**：
   - `.env` 配置指向正式数据目录（如 `C:\Virtual_D\aiClaw`）
   - 运行服务使用正式数据

2. **运行测试**：
   - 测试自动使用 `.test-data/` 目录
   - 不会污染正式数据
   - 测试配置在 `.test-data/config.json`

3. **同步配置**：
   - 测试环境的 `config.json` 和正式环境的 `config.json` 是独立的
   - 需要手动同步配置变更
   - 或者复制正式配置到测试环境

### 配置同步

如果需要在测试环境使用正式环境的配置：

**方法 1：使用脚本（推荐）**
```bash
# 查看当前测试配置
pnpm test:config show

# 复制示例配置到测试目录
pnpm test:config copy

# 清理所有测试数据
pnpm test:config clean
```

**方法 2：手动复制**
```bash
# 复制正式配置到测试环境
cp C:\Virtual_D\aiClaw\config.json .test-data/global-test/config.json
```

**方法 3：复制示例配置**
```bash
# 项目根目录有示例配置文件
cp .test-data.config.example.json .test-data/global-test/config.json
```

测试配置说明：
- 测试配置位于 `.test-data/global-test/config.json`
- 示例配置位于项目根目录的 `.test-data.config.example.json`
- 每次测试运行前，测试目录会被清理
- 如果需要持久化测试配置，使用 `pnpm test:config copy` 创建配置文件

## .env 文件示例

项目根目录的 `.env` 文件（**必需**）：

```bash
# aiClaw 环境变量配置

# 用户数据目录（必需）
# Windows 示例: AICLAW_DATA_DIR=D:\MyData\aiclaw
# Linux/macOS 示例: AICLAW_DATA_DIR=/home/user/.aiclaw
AICLAW_DATA_DIR=C:\Virtual_D\aiClaw
```

参考 `.env.example` 文件可以查看所有可配置的环境变量。

## 清理测试数据

测试数据在项目根目录的 `.test-data/` 中：

```bash
# 清理测试数据
rm -rf .test-data/

# 或手动删除特定文件
rm .test-data/config.json
```

## 数据迁移

如果需要迁移数据到新位置：

1. 停止服务
2. 复制整个 `C:\Virtual_D\aiClaw\` 到新位置
3. 修改 `.env` 文件，设置 `AICLAW_DATA_DIR` 指向新位置
4. 启动服务验证
5. 确认无问题后删除旧数据
