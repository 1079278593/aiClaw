# 阶段 2：工具系统 - 功能规格

## 目标
添加工具调用能力，让 AI 能执行文件操作

## 功能清单

### 1. 工具调用基础设施
- [x] 工具定义接口（name、description、parameters schema、handler）
- [x] 工具注册机制（工具列表管理）
- [x] LLM 工具调用协议（发送 tools schema、解析 tool_use 响应）
- [x] 工具执行流程（调用 handler、返回 tool_result）
- [x] 多轮工具调用循环（直到 LLM 返回最终文本，或达到最大调用次数）
- [x] 最大工具调用次数限制（config 配置项 `agent.maxToolCalls`，默认 10，超出后终止循环并返回当前结果）
- [x] 工具执行错误处理（向 LLM 返回错误信息）

### 2. 文件系统安全
- [x] 路径安全校验（基于 `fs.allowedDirs` 配置）
- [x] 支持相对路径（相对于用户数据目录 `C:\Virtual_D\aiClaw\`）
- [x] 支持绝对路径（需在 allowedDirs 范围内）
- [x] 路径穿越攻击防护（拒绝 `../` 等越界路径）
- [x] 默认允许目录：`files`、`memory`、`knowledge`

### 3. 文件工具
- [x] `list` - 列出目录内容
  - 参数：`path`（目录路径）
  - 返回：文件和子目录列表（名称、类型、大小）
  - 安全：路径必须在 allowedDirs 内
- [x] `read` - 读取本地文件内容
  - 参数：`path`（文件路径）、`encoding`（可选，默认 utf-8）
  - 安全：路径必须在 allowedDirs 内
- [x] `write` - 写入本地文件（覆盖）
  - 参数：`path`、`content`
  - 安全：路径必须在 allowedDirs 内
  - 自动创建父目录
- [x] `edit` - 编辑本地文件（字符串替换）
  - 参数：`path`、`old_string`、`new_string`
  - 安全：路径必须在 allowedDirs 内
  - old_string 不存在时返回错误

### 4. Web 界面工具调用展示
- [x] 工具调用过程在对话中可见（显示调用了哪个工具、参数）
- [x] 工具执行结果折叠展示（默认折叠，可展开查看）

## 验收标准
- [x] AI 能读取 `files/` 目录下的文件内容
- [x] AI 能写入和编辑 `files/` 目录下的文件
- [x] 文件操作被限制在 allowedDirs 范围内，越界操作返回错误
- [x] 工具调用过程在 Web 界面中可见

## 暂不实现
- 网络工具（web_search、web_fetch）
- 记忆相关工具（memory_search、memory_get）
- 知识库相关工具（knowledge_search、knowledge_get）
- 工具启用/禁用配置
