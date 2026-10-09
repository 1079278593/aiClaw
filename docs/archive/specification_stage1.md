# 阶段 1：基础对话（最小可用版本）- 功能规格

## 目标
实现最简单的对话功能，无记忆、无工具、无知识库

## 功能清单

### 1. 配置系统
- [x] 配置文件读取 (`C:\Virtual_D\aiClaw/config.json`)
- [x] API Key 直接存储在 config.json 中
- [x] 配置验证（启动时检查）
- [x] 默认配置生成

### 2. 用户数据目录初始化
- [x] 检查并创建 `C:\Virtual_D\aiClaw/` 目录
- [x] 创建子目录：`logs/`, `conversations/`, `memory/`, `knowledge/`, `files/`, `database/`
- [x] 生成默认配置文件（如果不存在）

### 3. LLM 提供商接口
- [x] 智谱 (z.ai / GLM) 实现
- [x] 聊天接口抽象
- [x] 错误处理与重试机制

### 4. 会话管理
- [x] 创建会话
- [x] 切换会话
- [x] 列出会话
- [x] 默认加载上一次使用的会话
- [x] 删除会话
- [x] 新建会话时用户输入名称

### 5. 消息存储
- [x] JSONL 格式存储
- [x] 消息 ID 生成
- [x] 时间戳记录

### 6. Web 界面基础
- [x] 消息收发
- [x] 会话列表
- [x] WebSocket 通信

### 7. 文件日志
- [x] 日志写入 `C:\Virtual_D\aiClaw/logs/` 目录
- [x] 按日期轮转

### 8. 上下文控制
- [x] 每次发送取最近 N 条消息（config 配置）
- [x] 限制最大 token 数量（config 配置）

### 9. System Prompt
- [x] 从文件加载 system prompt
- [x] 在 config 中配置路径

## 验收标准
- [x] 能发送消息并收到回复
- [x] 能创建和切换会话
- [x] 刷新页面后消息不丢失
- [x] API 失败时自动重试
- [x] 日志可查询

## 暂不实现
- 记忆系统
- 工具调用
- 知识库
- Embedding
