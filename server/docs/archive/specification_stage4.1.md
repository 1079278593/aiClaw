# 阶段 4.1 规格文档：Token 统计 + Thinking 开关

## 1. 功能概述

本阶段目标：让用户能看到每轮对话消耗的 token 数，并可在 UI 上切换 thinking 模式。

---

## 2. Token 统计

### 2.1 数据来源

- 每次 LLM 调用（`complete()` 和 `stream()`）返回的 `usage` 字段（ZAI 完整结构）：
  ```
  {
    prompt_tokens, completion_tokens, total_tokens,
    prompt_tokens_details?: { cached_tokens },
    completion_tokens_details?: { reasoning_tokens }
  }
  ```
- 一次完整的用户请求可能包含多轮 `complete()`（工具调用循环）+ 一次 `stream()`，需累加所有轮次的 usage
- `reasoning_tokens` 不存在时当 0 处理（工具调用轮次通常不含 thinking）

### 2.2 数据结构

每个供应商负责将自己的 usage 字段映射到统一结构：

```typescript
interface UsageRecord {
  model: string;
  provider: string;         // "zai" | "anthropic" | "openrouter"
  inputTokens: number;      // 非 thinking 的输入 token
  outputTokens: number;     // completion_tokens - reasoning_tokens（纯回复内容，用于上下文判断）
  billingOutputTokens: number; // completion_tokens（含 thinking，用于计费统计）
  thinkingTokens?: number;  // thinking 消耗的 token（如有）
  cachedTokens?: number;    // 缓存命中的 token（如有）
  timestamp: string;        // ISO 8601
  sessionId: string;
}
```

各供应商映射规则（以 ZAI 为例）：
- `inputTokens` ← `prompt_tokens`
- `outputTokens` ← `completion_tokens - reasoning_tokens`（纯回复，不含 thinking）
- `billingOutputTokens` ← `completion_tokens`（含 thinking，计费用）
- `thinkingTokens` ← `completion_tokens_details.reasoning_tokens`
- `cachedTokens` ← `prompt_tokens_details.cached_tokens`

> 其他供应商（OpenRouter 等）在接入时各自实现映射，抽象层只暴露 `UsageRecord`。

### 2.3 前端显示

- 位置：页面顶部右侧，常驻显示
- 内容：`↑ {inputTokens}  ↓ {outputTokens}  Σ {inputTokens + outputTokens}`
  - `outputTokens` = `completion_tokens - reasoning_tokens`（纯回复内容，不含 thinking，反映上下文长度）
- 初始状态：空，收到第一次 `chatEnd` 后才显示
- 每次 `chatEnd` 更新为最新值（覆盖，不累加）
- 如果 LLM 未返回 usage，保持上一次的值不变

### 2.4 持久化

- 每次请求完成后，将 `UsageRecord` 以 JSONL 格式追加写入 `$AICLAW_DATA_DIR/files/usage.jsonl`
- 文件不存在时自动创建
- 不做读取/查询优化，统计页面直接读全文件

### 2.5 统计页面

- 入口：右侧边栏（新增），放置功能按钮，后续其他功能也在此扩展
- 右侧边栏包含一个 Token 统计按钮，点击后弹出统计面板（modal 或 drawer）
- 统计面板内容：按 `provider + model` 分组，展示累计 inputTokens 和 outputTokens
- 格式示例：

  | 模型 | 供应商 | 累计输入 | 累计输出（含 thinking） | 累计 Thinking |
  |------|--------|----------|------------------------|---------------|
  | glm-4.7 | zai | 12,345 | 5,801 | 1,234 |

- 数据来源：读取 `GET /api/usage/stats`，后端合并 `usage.jsonl` 和历史归档后聚合返回

### 2.6 usage 归档机制

每次调用 `GET /api/usage/stats` 时，后端执行以下流程：

1. 读取 `$AICLAW_DATA_DIR/files/usage.jsonl`
2. 若文件非空：
   a. 将本次数据按 `provider + model` 聚合
   b. 读取历史归档 `$AICLAW_DATA_DIR/files/usage_archive.json`（不存在则视为空）
   c. 将本次聚合结果合并到历史归档，写回 `usage_archive.json`
   d. 清空 `usage.jsonl`（截断为空文件）
3. 返回 `usage_archive.json` 中的全部聚合数据

归档文件格式（`usage_archive.json`）：

```json
[
  { "provider": "zai", "model": "glm-4.7", "inputTokens": 12345, "outputTokens": 4567, "billingOutputTokens": 5801, "thinkingTokens": 1234 },
  ...
]
```

### 2.7 API

新增 HTTP 端点：

- `GET /api/usage/stats` — 触发归档流程，返回聚合后的统计数据（JSON 数组）

### 2.8 WebSocket 协议变更

`chatEnd` 消息新增 `usage` 字段：

```typescript
{ type: "chatEnd"; sessionId: string; fullResponse: string; usage?: { inputTokens: number; outputTokens: number; billingOutputTokens: number; thinkingTokens?: number; model: string; provider: string } }
```

---

## 3. Thinking 开关

### 3.1 行为

- 默认值：从 `config.json` 的 `agent.enableThinking` 读取
- 切换仅影响当前会话，不持久化，刷新页面后恢复默认值

### 3.2 前端 UI

- 位置：右侧边栏（与 Token 统计按钮同栏）
- 形态：图标切换按钮（💭），激活时高亮
- 初始状态：页面加载时从 `GET /api/config` 读取 `agent.enableThinking`

### 3.3 协议变更

`chatMessage` 新增 `enableThinking` 字段：

```typescript
{ type: "chatMessage"; content: string; enableThinking?: boolean }
```

服务端收到后，本次请求优先使用 `chatMessage.enableThinking`，不修改内存中的全局 config 对象。实现方式：在 `processChatMessage` 层取值后以 `ChatOptions.enableThinking` 传入 `chatStream`，全局 config 始终只读。

---

## 4. 实现要点

### 4.1 stream() 的 usage 获取

经验证，ZAI（GLM）流式响应的最后一个 chunk（`finish_reason` 非空）在**顶层**包含完整 `usage`：

```json
{
  "choices": [{ "finish_reason": "stop", "delta": { "content": "" } }],
  "usage": {
    "prompt_tokens": 8,
    "completion_tokens": 50,
    "total_tokens": 58,
    "prompt_tokens_details": { "cached_tokens": 2 },
    "completion_tokens_details": { "reasoning_tokens": 50 }
  }
}
```

当前 `zai.ts` 的 `stream()` 在 `finish_reason` 非空时直接 `return`，没有读顶层 `usage`，需要补上。

实现方案：
- `ZaiChunk` 接口补充顶层 `usage` 字段
- `StreamChunk` 新增 `{ type: "usage", ... }` 类型
- `stream()` 在 `finish_reason` 非空时，先 yield `{ type: "usage", usage }` 再 return
- `chatStream()` 收到 usage chunk 后累加到本次请求总计，随 `chatEnd` 一起发给前端

> 其他 OpenAI 兼容供应商（OpenRouter 等）的流式 usage 行为待接入时单独验证，各自实现映射。

### 4.2 GET /api/config

返回当前 config 的非敏感字段，供前端读取初始值：

```typescript
{
  agent: {
    provider: string;
    model: string;
    enableThinking: boolean;
    // 不含 apiKey
  }
}
```

---

## 5. 其他变更

### 5.1 fs.allowedDirs 默认值调整

将 `files` 加入默认允许目录，使 AI 可以读写 `files/prompts/` 等文件，需同步修改两处：

```typescript
// src/config/schema.ts — Zod 默认值
allowedDirs: z.array(z.string()).default(["inputs", "knowledge_base", "files"])

// src/config/index.ts — DEFAULT_CONFIG
fs: {
  allowedDirs: ["inputs", "knowledge_base", "files"],
  ...
}
```

---

## 6. 不在本阶段实现

- 按时间范围筛选统计数据
- 多模型切换 UI（仅 thinking 开关）
