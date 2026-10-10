# 阶段 4.2 规格文档：手动会话压缩

## 功能概述

用户点击压缩按钮，将当前会话的历史消息用 LLM 压缩为摘要。原始 `.jsonl` 文件归档，会话文件替换为仅含摘要的精简版本。

---

## 涉及文件

| 文件 | 改动类型 |
|------|----------|
| `src/config/schema.ts` | 新增 `CompactionConfig`，加入顶层 `Config`；移除 `fs.agentSystemPromptFile` |
| `src/config/paths.ts` | 新增 `conversationArchive`、`compactionPromptFile`、`agentSystemPromptFile` 路径 |
| `src/config/index.ts` | `initConfig()` 补充初始化 `compaction_prompt.txt`；移除 `agentSystemPromptFile` 写入 config.json；`mergeWithDefaults()` 删除对应字段 |
| `src/chat/index.ts` | `loadSystemPrompt()` 改用 `paths.agentSystemPromptFile`，移除对 `config.fs.agentSystemPromptFile` 的引用 |
| `src/chat/compaction.ts` | 新增文件，实现 `compactSession()` |
| `src/server/index.ts` | 新增 `POST /api/sessions/:id/compact` 路由 |
| `src/server/public/index.html` | 新增压缩按钮、压缩中状态、压缩完成后刷新会话 |

---

## 数据结构

### CompactionConfig（新增）

```typescript
// src/config/schema.ts
export interface CompactionConfig {
  provider?: string;        // 空/省略时继承 agent.provider
  model?: string;           // 空/省略时继承 agent.model
  apiKey?: string;          // 空/省略时继承 agent.apiKey
  baseUrl?: string;         // 空/省略时继承 agent.baseUrl
  enableThinking?: boolean; // 省略时继承 agent.enableThinking
}
```

schema 定义：

```typescript
const CompactionConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional().or(z.literal("")),
  enableThinking: z.boolean().optional(),
});
```

加入顶层 `ConfigSchema`：

```typescript
compaction: CompactionConfigSchema.default({}),
```

`DEFAULT_CONFIG` 同步：

```typescript
compaction: {},
```

**继承规则**：`compactSession()` 中构造 `CompletionOptions` 时，每个字段用 `config.compaction.xxx ?? config.agent.xxx`。

### 路径（新增）

```typescript
// src/config/paths.ts
conversationArchive: path.join(base, "conversation_archive"),
compactionPromptFile: path.join(base, "files", "prompts", "compaction_prompt.txt"),
agentSystemPromptFile: path.join(base, "files", "prompts", "agent_system_prompt.txt"),
```

### fs.agentSystemPromptFile 配置项移除

`config.fs.agentSystemPromptFile` 从 schema 和 `DEFAULT_CONFIG` 中删除，改为约定路径 `paths.agentSystemPromptFile`。

涉及改动：
- `src/config/schema.ts`：`FSConfigSchema` 删除 `agentSystemPromptFile` 字段
- `src/config/index.ts`：`initConfig()` 中写入 config.json 时去掉 `fs.agentSystemPromptFile`；`mergeWithDefaults()` 中删除对应合并逻辑
- `src/chat/index.ts`：`loadSystemPrompt()` 改为直接读取 `paths.agentSystemPromptFile`，不再从 config 读取

### 初始化改动（src/config/index.ts）

`initConfig()` 中补充初始化 `compaction_prompt.txt`，与 `agent_system_prompt.txt` 的初始化逻辑并列：

```typescript
// Initialize files/prompts/compaction_prompt.txt
const compactionPromptFile = paths.compactionPromptFile;
if (!(await pathExists(compactionPromptFile))) {
  await fs.mkdir(path.dirname(compactionPromptFile), { recursive: true });
  await fs.writeFile(compactionPromptFile, BUILTIN_COMPACTION_PROMPT, "utf-8");
}
```

`BUILTIN_COMPACTION_PROMPT` 常量定义在 `src/chat/compaction.ts`，由 `initConfig()` 导入使用（或在 `index.ts` 内联）。

同时，`initConfig()` 写入 config.json 时去掉 `fs` 字段（因为 `agentSystemPromptFile` 已移除，`fs` 只剩 `allowedDirs` 等，保持默认即可，不写入 config.json）。

---

## 核心逻辑：compactSession()

**文件**：`src/chat/compaction.ts`（新建）

**函数签名**：

```typescript
export async function compactSession(
  sessionId: string,
  config: Config,
  logger: Logger,
): Promise<void>
```

**执行步骤**：

1. **读取会话消息**：从 `paths.conversations/<sessionId>.jsonl` 读取所有消息。若消息数 < 2，抛出错误（无需压缩）。

2. **加载压缩提示词**：
   - 优先读取 `paths.compactionPromptFile`（`$AICLAW_DATA_DIR/files/prompts/compaction_prompt.txt`）
   - 文件不存在时，使用内置默认提示词（见下方）

3. **调用 LLM 生成摘要**：
   - 使用 `complete()`（非流式），不使用工具
   - 模型：`config.compaction.model || config.agent.model`
   - 构造消息：将所有历史消息序列化为文本，作为 user 消息内容，附加压缩提示词
   - 消息格式：
     ```
     <conversation>
     [role]: [content]
     ...
     </conversation>

     [compaction_prompt]
     ```

4. **归档原始文件**：
   - 目标路径：`paths.conversationArchive/<sessionId>_<timestamp>.jsonl`
   - 确保 `conversation_archive/` 目录存在
   - 复制（不删除）原始文件到归档路径

5. **写入压缩后的会话文件**：
   - 新会话文件 = 两条消息（JSONL，每行一条）：
     ```jsonl
     {"role":"user","content":"请回顾之前的对话","timestamp":"..."}
     {"role":"assistant","content":"[LLM 生成的摘要]","timestamp":"..."}
     ```
   - 覆盖写入 `paths.conversations/<sessionId>.jsonl`

6. **错误处理**：任何步骤失败时，不修改原始文件，抛出错误由调用方处理。

### 内置默认压缩提示词

```
你的任务是为本次对话创建一份详细的摘要。这份摘要将被置于一个后续会话的开头；在此摘要之后，将会跟随更新的消息以延续上下文。请进行详尽的总结，以便阅读者仅通过你的摘要和随后的新消息，就能完全理解之前发生的情况并继续开展工作。

请按以下结构输出：

## 对话背景
[理解上述内容所需的前提信息，比如用户的立场、讨论的出发点、已知条件]

## 讨论主题
[本次对话围绕的核心问题或领域，一到两句话概括]

## 主要观点与结论
[用户和助手达成的共识、重要推论、值得记住的判断。每条结论单独一行，用"-"开头]

## 关键概念与引用
[涉及的理论、人物、书籍、术语，每条简短说明其在对话中的角色]

## 未解问题
[对话中提出但没有深入讨论的问题，或留待下次继续的疑问]
```

---

## HTTP 路由

### POST /api/sessions/:id/compact

**请求**：无 body

**成功响应**（200）：

```json
{ "ok": true, "archivedAs": "sessionId_2026-04-23T10-00-00.jsonl" }
```

**错误响应**（400）：

```json
{ "error": "Session has fewer than 2 messages, compaction not needed" }
```

**错误响应**（500）：

```json
{ "error": "Compaction failed: ..." }
```

**实现要点**：
- 压缩期间若有 WebSocket 客户端正在该会话中流式输出，应返回 409（暂不实现，留作后续）
- 压缩完成后，服务端通过 WebSocket 向所有加入该会话的客户端广播 `sessionLoaded`（重新加载会话）

---

## 前端改动

### 压缩按钮

在 `#chat-header` 右侧（token 显示左侧）新增一个压缩按钮：

```html
<button id="compact-btn" title="压缩会话" disabled>⚡</button>
```

- 无会话时 `disabled`
- 会话消息数 < 2 时 `disabled`（通过 `sessionLoaded` 消息中的 `messages.length` 判断）
- 正在流式输出时（`isStreaming === true`）`disabled`

### 交互流程

1. 用户点击压缩按钮
2. 弹出确认对话框：`确认压缩当前会话？原始记录将归档，会话将替换为摘要。`
3. 用户确认后：
   - 按钮变为 `⏳` 并 `disabled`
   - 调用 `POST /api/sessions/:id/compact`
4. 成功后：
   - 按钮恢复
   - 重新加载当前会话（调用 `loadSession(currentSessionId)`，或等待服务端广播 `sessionLoaded`）
5. 失败后：
   - 按钮恢复
   - 显示错误提示（复用现有 toast/alert 机制，若无则用 `alert()`）

---

## 测试

### src/chat/compaction.test.ts（新建）

```typescript
describe("compactSession", () => {
  it("should throw if session has fewer than 2 messages")
  it("should archive original file before overwriting")
  it("should write exactly 2 messages to session file after compaction")
  it("should use compaction_prompt.txt if it exists")
  it("should fall back to built-in prompt if compaction_prompt.txt does not exist")
})
```

测试策略：mock `LLMProvider.complete()`，使用临时目录（`tmp` 或 `os.tmpdir()`）验证文件操作。

### src/server/index.test.ts（补充）

在 `describe("HTTP")` 块内新增：

```typescript
it("should return 200 at POST /api/sessions/:id/compact for valid session")
it("should return 400 if session has fewer than 2 messages")
```

---

## 执行顺序

1. Step 1（schema + paths）— 移除 `agentSystemPromptFile` 配置，新增路径常量
2. Step 2（config/index.ts）— 更新 `initConfig()` 和 `mergeWithDefaults()`
3. Step 3（chat/index.ts）— `loadSystemPrompt()` 改用 paths
4. Step 4（compaction.ts 核心逻辑）
5. Step 5（server 路由）
6. Step 6（前端按钮与交互）
7. Step 7（测试）
8. `pnpm build && pnpm test --run` 验证
