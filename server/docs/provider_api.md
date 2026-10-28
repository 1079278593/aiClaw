# Provider API 维护说明

> 当前实现不再使用 `none` / `minimal` / `low` / `medium` / `high` 的统一映射。模型在 `config.json` 的 `thinking` 数组中声明 provider 原生值，前端在该列表前自动加入 `none`。`none` 会显式关闭 thinking：Z.AI 和 DeepSeek 传 `thinking: { type: "disabled" }`，DashScope 传 `enable_thinking: false`。下文关于“五档统一抽象”的内容仅保留为历史调研记录。

模型级配置格式如下。`params` 会原样合并到请求体，`thinkingOff` 是前端自动补充的 `none` 所使用的请求参数：

```json
{
  "id": "deepseek-v4-flash",
  "thinking": [
    { "id": "high", "params": { "enable_thinking": true, "reasoning_effort": "high" } },
    { "id": "max", "params": { "enable_thinking": true, "reasoning_effort": "max" } }
  ],
  "thinkingOff": { "enable_thinking": false }
}
```

在百炼 OpenAI 兼容接口中：Qwen3.6/3.7 使用 `enable_thinking` 和 `thinking_budget`；GLM-5.2 与 DeepSeek-V4 使用 `enable_thinking` 和 `reasoning_effort`；Kimi-K2.6 只使用 `enable_thinking`。

历史思考回传（`preserve_thinking`）：项目现在会把所有 provider 的历史 `reasoning_content` 随消息发送。dashscope 默认不将历史 reasoning 拼接进输入，需要在请求参数中显式开启 `preserve_thinking: true`（支持 qwen3.6/3.7/3.8 系列与 kimi-k2.6/k2.7 等，qwen3.8 系列强制开启；未配置的模型不会自动添加）。因此 `qwen3.7-flash` / `qwen3.7-plus` 的 `thinking` 各档和 `thinkingOff` 都携带 `preserve_thinking: true`。

本文档记录当前项目中各 LLM provider 的实际调用方式，重点覆盖：

- 非流式调用方式
- Thinking 开关差异
- Thinking budget 的统一抽象与 provider 内部映射
- Token usage 返回格式与项目内标准化方式

当前支持的 provider：

- `zai`
- `dashscope`
- `deepseek`

相关实现文件：

- `src/llm/providers/zai.ts`
- `src/llm/providers/dashscope.ts`
- `src/llm/providers/deepseek.ts`
- 公共类型：`src/llm/types.ts`

---

## 1. 统一接口

所有 provider 都实现统一接口：

- `complete(apiKey, messages, options)`

当前项目的工具调用阶段与最终回复阶段，核心都围绕 `complete()` 组织；  
后续阶段 7 refactor 已决定：

- 不再依赖 provider 原生 `stream()` 做最终回复
- 最终回复改为基于最后一次 `complete()` 的结果做服务端“伪流式”输出

因此这里不再展开记录 provider 原生流式细节，后续维护重点放在：

- 请求体字段差异
- 工具调用差异
- thinking / budget 差异
- usage 差异

统一的 `CompletionOptions` 定义在 `src/llm/types.ts`，当前相关字段为：

```ts
interface CompletionOptions {
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  tools?: LLMTool[];
  thinkingEffort?: string; // model-configured native value, or "none"
  responseFormat?: { type: "json_object" | "text" };
}
```

统一的标准化 usage 结构为：

```ts
interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  billingOutputTokens: number;
  thinkingTokens?: number;
  cachedTokens?: number;
}
```

字段含义：

- `inputTokens`：输入 token
- `outputTokens`：实际文本输出 token
- `billingOutputTokens`：计费输出 token
- `thinkingTokens`：思考 token
- `cachedTokens`：命中缓存的输入 token

---

## 2. Thinking Budget 统一抽象

对用户暴露的 thinking 强度，不再使用数字，而是统一为五档：

- `none`
- `minimal`
- `low`
- `medium`
- `high`

语义约定：

- `none`：不推理
- `minimal` / `low` / `medium` / `high`：开启推理，强度逐级增加

重要原则：

- 用户侧、前端、配置层始终只暴露这五档
- 不直接暴露 provider 原生的 thinking/budget 写法
- 各 provider 在自己的实现文件内负责把这五档映射成底层 API 可接受的参数

---

## 3. ZAI

实现文件：

- `src/llm/providers/zai.ts`

可用 endpoint：

- Global: `https://api.z.ai/api/paas/v4`
- CN: `https://open.bigmodel.cn/api/paas/v4`

默认配置口径：

- 默认初始化配置使用 CN endpoint：
  - `https://open.bigmodel.cn/api/paas/v4`

请求路径：

- `POST {baseUrl}/chat/completions`

### 3.1 非流式调用

请求体主要结构：

```json
{
  "model": "...",
  "messages": [...],
  "temperature": 0.7,
  "max_tokens": 4096,
  "stream": false,
  "tools": [...],
  "thinking": {
    "type": "enabled"
  }
}
```

说明：

- `stream` 固定为 `false`
- 有工具时才传 `tools`
- `responseFormat` 存在时传 `response_format`
- thinking 通过 `thinking.type` 控制

### 3.2 Thinking 控制方式

ZAI 的 thinking 控制方式：

- 开启（保留历史思考）：
  ```json
  { "thinking": { "type": "enabled", "clear_thinking": false } }
  ```
- 关闭：
  ```json
  { "thinking": { "type": "disabled" } }
  ```

`clear_thinking`（Preserved Thinking）：`false` 表示保留历史思考，供多轮 tool-call 中参考上一轮的 `reasoning_content`；与 dashscope 的 `preserve_thinking` 对应。当前模板中 `glm-5.3` / `glm-5.3-flash` 的各档 thinking 均携带 `clear_thinking: false`（这两个模型强制思考，不能关闭，故无 thinkingOff）。

注意：

- `GLM-5.3` / `GLM-5.3-FLASH` 强制思考，传 `disabled` 会报错，未配置 thinkingOff

### 3.3 Thinking Budget 映射

ZAI 当前不支持数值型 thinking budget。  
因此在统一五档抽象下，映射策略为：

- `none` -> `thinking: { type: "disabled" }`
- `minimal` -> `thinking: { type: "enabled" }`
- `low` -> `thinking: { type: "enabled" }`
- `medium` -> `thinking: { type: "enabled" }`
- `high` -> `thinking: { type: "enabled" }`

说明：

- 对 `zai` 而言，除 `none` 外，其余四档当前都等价于“开启 thinking”
- 也就是说，四个强度档在 `zai` 上目前只有统一语义，没有底层数值差异
- 如果未来 `zai` 提供更细粒度推理预算参数，再在 provider 内补映射

### 3.4 Token usage 返回格式

ZAI 原始 usage 结构，当前实现按如下字段读取：

```json
{
  "prompt_tokens": 123,
  "completion_tokens": 456,
  "total_tokens": 579,
  "prompt_tokens_details": {
    "cached_tokens": 10
  },
  "completion_tokens_details": {
    "reasoning_tokens": 80
  }
}
```

标准化映射规则：

- `inputTokens = prompt_tokens`
- `thinkingTokens = completion_tokens_details.reasoning_tokens`
- `outputTokens = completion_tokens - thinkingTokens`
- `billingOutputTokens = completion_tokens`
- `cachedTokens = prompt_tokens_details.cached_tokens`

注意：

- ZAI 的 `completion_tokens` 包含 thinking token
- 因此项目里会从中扣掉 `reasoning_tokens`，得到文本输出 token

### 3.5 工具调用

ZAI 非流式支持工具调用：

- `complete()` 里会传 `tools`
- 响应中读取：
  - `choice.message.tool_calls`

当前项目中的工具调用阶段主要依赖：

- 非流式 `complete()`

---

## 4. DashScope

实现文件：

- `src/llm/providers/dashscope.ts`

默认 endpoint：

- `https://dashscope.aliyuncs.com/compatible-mode/v1`

请求路径：

- `POST {baseUrl}/chat/completions`

### 4.1 非流式调用

请求体主要结构：

```json
{
  "model": "...",
  "messages": [...],
  "temperature": 0.7,
  "max_completion_tokens": 4096,
  "stream": false,
  "enable_thinking": false,
  "thinking_budget": 512,
  "tools": [...]
}
```

说明：

- `stream` 固定为 `false`
- `enable_thinking` 当前实现始终显式传
- `thinking_budget` 只有在需要时才传
- 有工具时才传 `tools`
- `responseFormat` 存在时传 `response_format`

### 4.2 Thinking 控制方式

DashScope 的 thinking 控制方式：

- 开启：
  ```json
  { "enable_thinking": true }
  ```
- 关闭：
  ```json
  { "enable_thinking": false }
  ```

当前实现特点：

- 当前项目会显式传 `enable_thinking`
- 不依赖模型默认行为

### 4.3 Thinking Budget 映射

DashScope 当前支持数值型 thinking budget。  
在统一五档抽象下，映射策略为：

- `none` -> 不开启 thinking，不传数值型 budget
- `minimal` -> `512`
- `low` -> `1024`
- `medium` -> `4096`
- `high` -> `8192`

建议的底层写法：

```json
{
  "enable_thinking": true,
  "thinking_budget": 4096
}
```

其中：

- `none`：
  - `enable_thinking: false`
  - 不传 `thinking_budget`
- 其余四档：
  - `enable_thinking: true`
  - 按档位传 `thinking_budget`

### 4.4 Token usage 返回格式

DashScope 当前实现按如下结构读取 usage：

```json
{
  "prompt_tokens": 14,
  "completion_tokens": 123,
  "prompt_tokens_details": {
    "text_tokens": 14,
    "cached_tokens": 0
  },
  "completion_tokens_details": {
    "text_tokens": 23,
    "reasoning_tokens": 100
  }
}
```

标准化映射规则：

- `inputTokens = prompt_tokens`
- `outputTokens = completion_tokens_details.text_tokens ?? completion_tokens`
- `billingOutputTokens = completion_tokens`
- `thinkingTokens = completion_tokens_details.reasoning_tokens`
- `cachedTokens = prompt_tokens_details.cached_tokens`

注意：

- DashScope 的 `completion_tokens` 通常表示总计费输出
- 文本输出 token 优先取 `completion_tokens_details.text_tokens`
- 如果没有 `text_tokens`，当前实现退回使用 `completion_tokens`

### 4.5 工具调用

DashScope 非流式支持工具调用：

- `complete()` 里会传 `tools`
- 响应中读取：
  - `choice.message.tool_calls`

当前项目中的工具调用阶段主要依赖：

- 非流式 `complete()`

---

## 5. DeepSeek

实现文件：
- `src/llm/providers/deepseek.ts`

默认 endpoint：
- `https://api.deepseek.com`

请求路径：
- `POST {baseUrl}/chat/completions`

### 5.1 非流式调用
请求体主要结构：

```json
{
  "model": "...",
  "messages": [...],
  "temperature": 0.7,
  "max_tokens": 4096,
  "stream": false,
  "thinking": {
    "type": "enabled"
  },
  "reasoning_effort": "high",
  "tools": [...]
}
```

说明：
- `stream` 固定为 `false`
- thinking 通过 `thinking.type` 控制
- thinking 强度通过 `reasoning_effort` 控制
- 有工具时才传 `tools`
- `responseFormat` 存在时传 `response_format`

### 5.2 Thinking 控制方式

DeepSeek 的 thinking 控制方式：
- 开启：
  ```json
  { "thinking": { "type": "enabled" } }
  ```
- 关闭：
  ```json
  { "thinking": { "type": "disabled" } }
  ```

当前实测特征：
- 非流式响应会直接返回 `choice.message.reasoning_content`
- 关闭 thinking 时通常没有 `reasoning_content`
- 开启 thinking 时，`completion_tokens` 包含 thinking token

### 5.3 Thinking Budget 映射

DeepSeek 当前不适合按 DashScope 那种数值 `thinking_budget` 接入。

已确认的底层参数是：
- `thinking.type`
- `reasoning_effort`

当前建议的五档映射：

- `none` -> `thinking: { type: "disabled" }`
- `minimal` -> `thinking: { type: "enabled" }, reasoning_effort: "high"`
- `low` -> `thinking: { type: "enabled" }, reasoning_effort: "high"`
- `medium` -> `thinking: { type: "enabled" }, reasoning_effort: "high"`
- `high` -> `thinking: { type: "enabled" }, reasoning_effort: "max"`

补充说明：
- 已实测 `reasoning_effort: "high"` 可用
- 已实测 `reasoning_effort: "max"` 可用
- 已实测额外传 `thinking_budget: 100` 会返回 `200`
- 但暂时看不出数值 `thinking_budget` 有明确控制效果，因此接入时不应依赖它

### 5.4 Token usage 返回格式

DeepSeek 实测 usage 结构：

```json
{
  "prompt_tokens": 19,
  "completion_tokens": 58,
  "total_tokens": 77,
  "prompt_tokens_details": {
    "cached_tokens": 0
  },
  "completion_tokens_details": {
    "reasoning_tokens": 56
  },
  "prompt_cache_hit_tokens": 0,
  "prompt_cache_miss_tokens": 19
}
```

标准化映射规则：

- `inputTokens = prompt_tokens`
- `thinkingTokens = completion_tokens_details.reasoning_tokens`
- `outputTokens = completion_tokens - thinkingTokens`
- `billingOutputTokens = completion_tokens`
- `cachedTokens = prompt_cache_hit_tokens`

注意：
- DeepSeek 的 `completion_tokens` 包含 thinking token
- 因此项目内应扣除 `reasoning_tokens`，得到真正展示给用户的输出 token
- `cachedTokens` 更适合读 `prompt_cache_hit_tokens`

### 5.5 工具调用

DeepSeek 为 OpenAI-compatible 风格接口，工具调用阶段可按非流式 `complete()` 方式处理：

- `complete()` 里传 `tools`
- 响应中读取：
  - `choice.message.tool_calls`

当前项目中的工具调用阶段主要依赖：
- 非流式 `complete()`

---

## 6. 三家 provider 的关键差异

### 6.1 Thinking 写法不同

- `zai`
  - `thinking: { type: "enabled" | "disabled" }`
- `dashscope`
  - `enable_thinking: true | false`
- `deepseek`
  - `thinking: { type: "enabled" | "disabled" }`
  - 配合 `reasoning_effort`

### 6.2 Thinking Budget 支持不同

- `zai`
  - 当前不支持数值型 budget
  - 五档里只有 `none` 和“非 none”在底层有区别
- `dashscope`
  - 当前支持数值型 budget
  - 五档可映射到不同数值

### 6.3 outputTokens 映射方式不同

- `zai`
  - `outputTokens = completion_tokens - reasoning_tokens`
- `dashscope`
  - `outputTokens = completion_tokens_details.text_tokens`
- `deepseek`
  - `outputTokens = completion_tokens - reasoning_tokens`

### 6.4 DeepSeek 补充

- `deepseek` 的 thinking budget 不建议依赖数值型 `thinking_budget`
- 当前更适合映射到 `reasoning_effort`

---

## 7. 维护建议

后续维护时，新增或修改 provider，建议逐项确认以下内容：

- endpoint / 鉴权方式是否变化
- 非流式请求体字段是否变化
- thinking 开关字段名
- 是否支持 budget，以及 budget 的原生参数格式
- 如何把统一五档：
  - `none`
  - `minimal`
  - `low`
  - `medium`
  - `high`
  映射到底层参数
- usage 中：
  - 文本输出 token 字段
  - thinking token 字段
  - cache token 字段
  - `completion_tokens` 是否包含 thinking token
- 工具调用是否出现在：
  - `message.tool_calls`
  - 或其他结构

如需实测 DashScope 行为，可参考：

- `scripts/probe-dashscope.mjs`
- `scripts/probe-deepseek.mjs`

DeepSeek 补充说明：
- 在 thinking mode 下，如果历史消息里保留了发生过 tool call 的 `assistant` 消息，却没有一起回传对应的 `reasoning_content`，API 可能返回 `400`
- 项目对 DeepSeek 模型的兼容策略：模型名以 `deepseek` 开头且开启 thinking 时，保留历史 `reasoning_content` 与 tool_calls / tool 消息一并发送
- 其他模型（及非 thinking 模式）：`sanitizeHistoryForProvider` 统一剥离历史 reasoning 避免上下文膨胀
- 当前轮 agent loop 内部的 reasoning_content 始终保留
