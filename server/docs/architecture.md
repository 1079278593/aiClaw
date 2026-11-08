# aiClaw - Technical Architecture

## 1. Tech Stack

### 1.1 Core Runtime
- **Node.js** >= 22.16.0
- **TypeScript** >= 5.9.3
- **pnpm** >= 10.23.0

### 1.2 Dependencies
- **commander** 14.x — CLI command parsing
- **zod** 4.x — Config schema validation
- **ws** 8.x — WebSocket server
- **tslog** 4.x — Structured logging
- **dotenv** 17.x — Environment variable loading

### 1.3 Development Tools
- **Vitest** 3.x — Testing framework
- **oxlint** — Linting
- **oxfmt** — Code formatting
- **tsx** — Dev server (hot reload)

### 1.4 LLM Providers (built-in)
- **智谱 (Zai)** — via `open.bigmodel.cn/api/paas/v4`, OpenAI-compatible API
- **阿里百炼 (DashScope)** — via `dashscope.aliyuncs.com/compatible-mode/v1`, OpenAI-compatible API

No third-party LLM SDKs — all providers use raw `fetch` over OpenAI-compatible HTTP endpoints.

### 1.5 Storage
- **JSONL** — Conversation history (`conversations/<id>.jsonl`)
- **Markdown** — Knowledge base indices (`knowledge_base/*/index.md`)
- **JSON** — Config (`config.json`), app state (`files/app_state.json`), token usage (`files/usage_temp.json` + `usage_daily.json` + `usage_total.json`)

No database, no ORM, no vector store. File system is the sole persistence layer.

---

## 2. Project Structure

### 2.1 Source Code (`src/`)

```
src/
├── cli/                  # CLI entry point (commander-based)
│   └── index.ts          # Commands: start, config, init, sessions, chat, status
├── server/               # HTTP + WebSocket server
│   ├── index.ts          # Lifecycle and dependency assembly only
│   ├── http.ts           # HTTP dispatch and error handling
│   ├── websocket.ts      # WebSocket connection lifecycle and dispatch
│   ├── chat-handler.ts   # Chat streaming and permission forwarding
│   ├── static-assets.ts  # Public and vendor asset delivery
│   ├── routes/           # System, session and content HTTP routes
│   ├── services/         # Usage, knowledge, command, document and media logic
│   └── public/           # Browser UI
│       ├── index.html    # Static page skeleton
│       ├── styles/       # Tokens, base, layout, chat and overlay styles
│       └── js/           # Native ES modules, features and renderers
├── chat/                 # Chat orchestration
│   ├── index.ts          # chat(), chatStream(), agentic loop, context truncation
│   ├── context-budget.ts # 上下文预算装配纯函数（锚定用户消息、按 turn 装填）
│   └── compaction.ts     # Session compaction (LLM-summarized history)
├── distill/              # 蒸馏区（AI 可写的缓存，plan_distill）
│   ├── format.ts         # 头解析 / 渲染 / 过期判定（纯函数，解析失败一律退化）
│   ├── store.ts          # 读写摘要、meta/overview.md 地图、_archive 保留 3 份
│   ├── generate.ts       # 收集来源 → LLM → 原子写 → 归档 → 重建地图；summarizer 可注入
│   └── inject.ts         # 地图注入（默认关）+ 与记忆共享预算、同来源去重
├── index/                # 目录级结构索引
│   ├── indexer.ts        # listChildEntries / compareNameZh / IndexWriter / L0 同步 / L1 校准 / listIndexableDirs
│   │                      # ensureIndexRoots：启动时为空 reflections/、reflections/inbox/、knowledge_base/ 补空 _index.md
│   │                      # L1 触发点：GET /api/reflections?view=tree（打开首页，校准根层）、
│   │                      #          GET /api/reflections/index、POST /api/reflections/index/rebuild（递归一次性）
│   ├── watcher.ts        # L2 加速：fs.watch + debounce 300ms，事件只当提示，写入仍走 IndexWriter
│   └── watcher-manager.ts # 按租户起 watcher（background.ts 启动时逐个 ensure）
├── memory/               # 单 Agent 记忆（plan §8）
│   ├── types.ts          # MemoryLayer / MemoryEntryMeta / 体积上限 / 归档份数
│   ├── store.ts          # 正文解析（`##` 分条）、index.jsonl 元数据、归档留 3 份、超限拒绝
│   ├── score.ts          # importance + recency(exp) + bigram Jaccard，pinned 恒定入选
│   └── inject.ts         # <memory trust="unverified"> 边界 + 指令式中和
├── pending/              # 提案区（通往知识区的唯一出口）
│   ├── store.ts          # createProposal / listPending / dismissProposal
│   ├── apply.ts          # 二路哈希 apply + baseHash 重定位 + 索引同步 + applyAllProposals（批量、非原子）
│   ├── archive-ttl.ts    # agents/people/distill 的 _archive 90 天清理
│   └── ttl.ts            # 30 天归档 → 再 30 天物理删除
├── reflections/          # 心得笔记（reflections/ 顶层目录）
│   ├── paths.ts          # 路径解析（只认新路径，旧 inputs/ 前缀 404）
│   ├── store.ts          # 增删改查、按日期归夹、批量导入
│   └── media.ts          # 附件读写
├── people/               # 人物资料（people/ 顶层目录）
│   ├── store.ts          # 档案 / 原文 / 历史简报
│   ├── profile.ts        # 档案行数与「砍半」保护
│   └── context.ts        # 咨询上下文注入
├── llm/                  # LLM provider layer
│   ├── index.ts          # createProvider() factory
│   ├── types.ts          # LLMProvider interface, CompletionOptions, UsageRecord
│   └── providers/
│       ├── zai.ts        # 智谱 OpenAI-compatible provider
│       └── dashscope.ts  # 阿里百炼 OpenAI-compatible provider
├── tools/                # Tool system
│   ├── index.ts          # initTools() - register all tools from config
│   ├── types.ts          # ToolDefinition, ToolResult, ToolContext, LLMTool
│   ├── registry.ts       # Module-level tool registry (register/get/clear)
│   ├── executor.ts       # executeTool() dispatcher
│   ├── file-tools.ts     # Built-in tools: list, read (text & images), write, edit, grep, move, delete
│   ├── propose-change.ts # propose_change：只写 pending/，不碰真相源
│   ├── risk.ts           # 工具风险分级（safe / session / always）
│   ├── web-tools.ts      # Optional Tavily search/fetch
│   ├── trilium-tools.ts  # Optional read-only Trilium tools
│   └── fs-policy.ts      # 三档 ACL：denied → writable → readable
├── trilium/              # Read-only Trilium ETAPI client
│   ├── client.ts         # Search, list children, read content
│   ├── html.ts           # HTML → readable text
│   ├── paths.ts          # trilium:{noteId} and browser paths
│   └── preview.ts        # Previewable note types
├── session/              # Session persistence
│   └── index.ts          # CRUD: list, load, save, create, delete, addMessage
├── config/               # Configuration
│   ├── index.ts          # loadConfig(), initConfig(), getProviderCredential()
│   ├── schema.ts         # Zod schema for config.json
│   └── paths.ts          # User data dir resolution, path constants
├── app-state/            # Lightweight app state persistence
│   └── index.ts          # lastActiveSessionId / reflectionsSessionId / recentModels
├── logger/               # Logging (tslog wrapper)
│   └── index.ts          # Logger class, getLogger(), module-level logger proxy
├── errors/               # Error classes
│   ├── index.ts          # AiClawError, ConfigError, LLMError, FileSystemError, ToolError
│   └── handler.ts        # ErrorHandler, withErrorHandling() wrappers
├── types/                # Shared TypeScript types
│   └── index.ts          # Message, Session, MessageRole, re-exports from config/llm
├── test-utils.ts         # Test helpers (setupTestDir, cleanupTestDir)
├── test-setup.ts         # Vitest global setup
└── index.ts              # Entry point → forwards to CLI
```

### 2.2 User Data Directory (`$AICLAW_DATA_DIR`)

```
$AICLAW_DATA_DIR/
├── config.json                          # Main configuration
├── conversations/                       # Session history (JSONL)
│   ├── <sessionId>.jsonl
│   └── ...
├── conversation_archive/                # Compaction archives
│   └── <sessionId>_<timestamp>.jsonl
├── inputs/                              # 已弃用：不再是模块根（reflections/ 与 people/ 已提到顶层）
├── reflections/                         # 心得笔记（AI 只读；改动走 pending）
│   ├── _index.md                        # 目录级结构索引（脚本写，Agent 逐层读）
│   └── inbox/
│       └── _index.md
├── people/                              # 人物资料（AI 可维护区，不放 _index.md）
│   └── <id>/{meta.json,entries.jsonl,profile.md,digest.md}
├── distill/                             # 蒸馏摘要（AI 可写，文档浏览器只读查看）
├── pending/                             # 提案区
│   ├── <proposalId>/{meta.json, base.md, proposed.md}
│   └── _archive/                        # 已应用 / 过期（30 天后再 30 天物理删）
├── agents/main/                         # 单 Agent 记忆
│   ├── AGENT.md                         # 宪法（AI 只读）
│   ├── user.md                          # 画像（AI 可写，`remember` layer=user）
│   ├── runtime.md                       # 工作记忆
│   └── memory/
│       ├── focus.md                     # 当前关注点（pinned，恒定注入）
│       ├── longterm.md                  # 长期记忆正文（`##` 分条，id 在 HTML 注释里）
│       ├── index.jsonl                  # 全部条目的元数据；used/lastUsed 每轮只改这里
│       └── _archive/                    # 覆盖前兜底，每文件保留最近 3 份
├── knowledge_base/                      # Knowledge base (markdown + files)
│   ├── _index.md                        # 目录级结构索引
│   ├── index.md                         # Global index of all knowledge bases
│   └── <base-name>/
│       ├── index.md                     # Per-base index (description + file list)
│       └── ...                          # Knowledge files
├── files/                               # AI 可写区（非「工作区」概念）
│   ├── app_state.json                   # UI state (lastActiveSessionId)
│   ├── usage_temp.json                  # Per-call token usage stream (pending archive)
│   ├── usage_daily.json                 # Daily buckets, last 30 days (date×model×provider)
│   ├── usage_total.json                 # Permanent cumulative totals (model×provider)
│   └── prompts/
│       ├── agent_system_prompt.txt        # System prompt template
│       └── compaction_prompt.txt        # Compaction prompt (optional)
└── logs/                                # Server logs
```

---

## 3. Module Responsibilities

### 3.1 CLI (`src/cli/`)
- `aiclaw start` — Start web server
- `aiclaw init` — Initialize the data directory and templates
- `aiclaw status` — Check configuration, data directory and startup readiness

### 3.2 Server (`src/server/`)
- **HTTP**: plain `node:http` server, no framework (no Express/Hono at runtime).
  `http.ts` dispatches to `routes/system.ts`, `routes/sessions.ts` and `routes/content.ts`.
- **WebSocket**: `websocket.ts` owns connection lifecycle and message dispatch; `chat-handler.ts` owns chat streaming and tool permission forwarding.
- **Static assets**: `static-assets.ts` serves the HTML skeleton, `/styles/*`, `/js/*` and allowlisted vendor assets with path containment checks.
- **Domain services**: `services/*` contain filesystem parsing, aggregation and content assembly without HTTP or WebSocket dependencies.
- **API endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve SPA UI |
| GET | `/health` | Health check（公开；含 `authRequired`、`version`、`commit`） |
| GET | `/api/config` | Available providers, models, defaults, `triliumEnabled` |
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create session |
| GET | `/api/sessions/:id` | Load session messages |
| PATCH | `/api/sessions/:id` | Rename session |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/sessions/:id/compact` | Compact session |
| POST | `/api/sessions/:id/truncate` | Restart from a user message |
| GET | `/api/app-state` | Load UI state |
| POST | `/api/app-state/reflections-session` | 绑定移动端心得会话（幂等） |
| GET | `/api/pending` | 待应用提案列表 + 角标 |
| GET | `/api/pending/:id` | 提案详情（meta + base + proposed） |
| POST | `/api/pending/:id/apply` | 应用（二路哈希；409 = 原文已变；200 + stale = 失效） |
| POST | `/api/pending/apply-all` | 批量应用（顺序、非原子；逐条返回，冲突不中止后续） |
| GET | `/api/distill/overview` | 蒸馏地图原文 |
| GET | `/api/distill/stale` | 过期摘要扫描（只读，不重算） |
| POST | `/api/distill/refresh` | 生成/重算一篇摘要（`scope` + `path` + `sources`） |
| POST | `/api/pending/:id/dismiss` | 丢弃（`status = expired`） |
| GET | `/api/reflections/index?path=` | 读某层 `_index.md`（读前先 L1 校准） |
| POST | `/api/reflections/index/rebuild` | 一次性重建：递归校准 `reflections/` + `knowledge_base/` 各层 |
| GET | `/api/usage/stats` | Aggregated token usage |
| GET | `/api/usage/daily` | Daily token usage |
| POST | `/api/usage/flush` | Archive pending usage records |
| GET | `/api/knowledge` | Knowledge base overview |
| GET | `/api/commands` | Search configured commands |
| GET | `/api/files` | Search allowed local files and, if enabled, Trilium notes |
| GET/PUT | `/api/documents/content` | Read or update a text document (Trilium paths are read-only) |
| GET | `/api/documents/tree` | Browse document roots (`knowledge_base`, optional `trilium`; `reflections` / `people` 各有独立入口) |

- **WebSocket message types**:

Client → Server:
| Type | Fields |
|------|--------|
| `ping` | — |
| `joinSession` | `sessionId` |
| `chatMessage` | `sessionId`, `content`, `images?`, `provider`, `model`, `thinkingEffort?`, `previewPath?`, `selectedPreviewText?` |
| `toolPermissionResponse` | `requestId`, `allowed` |
| `setWritePermission` | `enabled` |

Server → Client:
| Type | Fields |
|------|--------|
| `connected` | `message` |
| `pong` | — |
| `sessionLoaded` | `session: { id, title, messages, lastProvider?, lastModel? }` |
| `chatStart` | `sessionId` |
| `chatChunk` | `sessionId`, `chunk` |
| `chatReasoning` | `sessionId`, `chunk` |
| `chatEnd` | `sessionId`, `fullResponse`, `usage?` |
| `toolCall` | `sessionId`, `name`, `input` |
| `toolResult` | `sessionId`, `name`, `content`, `isError` |
| `toolPermissionRequest` | `sessionId`, `requestId`, `toolName`, `details` |
| `error` | `message`, `sessionId?` |

### 3.3 Chat (`src/chat/`)
- **`chatStream()`** — Async generator that drives the agentic loop, yields reasoning chunks and tool events in real-time, then sends the final text as a single `chatChunk`
- **Agentic loop** (`runAgenticLoop`): non-streaming LLM `complete()` calls, iterates tool-call→tool-result until `finish_reason !== "tool_calls"` or `maxToolCalls` reached
- **Final output**: the entire response text is sent in one `chatChunk`, then rendered as Markdown on `chatEnd`
- **Context truncation**: `truncateMessagesForContext()` — token-aware sliding window from newest to oldest
- **System prompt**: `loadSystemPrompt()` 单一来源——`agents/main/AGENT.md` 存在且非空时用它，否则退回 `files/prompts/agent_system_prompt.txt`（旧装兼容）；末尾始终追加 `今天的日期是YYYY/MM/DD`。这两个路径都在 ACL 的 `denied` 内，但那只约束 Agent 工具，系统内部加载不受限。
- **Compaction**: `compactSession()` 两步压缩（plan §9）——先独立调用一次 `extractConstraints()` 逐字抄写约束，再做现有摘要，结果拼成「摘要 + `## 以下为逐字保留的约束（勿改写）` + 清单」。约束提取失败只记日志，退回到原有的单步摘要。返回 `{ archivedAs, usage, constraints, constraintsExtracted }`。

### 3.4 LLM (`src/llm/`)
- **Provider interface** (`LLMProvider`): `complete(apiKey, messages, options)` → `CompletionResponse`
- **Provider implementations**: `ZaiProvider`, `DashScopeProvider`
- Both use raw `fetch` to OpenAI-compatible `/v1/chat/completions` endpoints
- `CompletionOptions`: `model`, `baseUrl`, `temperature`, `maxTokens`, `thinkingEffort`, `tools?`
- `CompletionResponse`: `content`, `finish_reason`, `tool_calls?`, `reasoning_content?`, `usage` (normalized)

### 3.5 Tools (`src/tools/`)
- **Registry**: module-level `tools[]` array, `registerTool()`, `getTools()`, `initTools()` clears then re-registers
- **Built-in tools**: `list`, `read`, `write`, `edit`, `grep`, `move`, `delete` — file operations under `$AICLAW_DATA_DIR/`. `read` handles both text and images: a text file returns its content (optional `offset`/`limit` line slicing; capped at 2000 lines / 50 KiB by default, soft-truncated with a notice on overflow), while an allowlisted PNG/JPEG/GIF/WebP file is returned as a multimodal tool result. The image branch is gated on the active model's vision support (`context.supportsImages`); non-vision models get a text error instead of the bytes.
- **Optional Tavily tools** (`tools.tavily.enabled` + apiKey): `web_search`, `web_fetch`
- **Optional Trilium tools** (`tools.trilium.enabled` + token): `trilium_search`, `trilium_list`, `trilium_read` — read-only ETAPI access via `src/trilium/`. Writes still go to local `knowledge_base/`. Note refs use `trilium:{noteId}`.
- **Path sandboxing** (`fs-policy.ts`): `resolveAllowedDirs()` resolves relative paths against data dir, `assertPathAllowed()` enforces whitelist
- **`executeTool()`**: dispatches tool calls by name, returns `ToolResult { content, isError? }`

### 3.6 Session (`src/session/`)
- JSONL format: one JSON object per line. First line is metadata message (`id: "meta"`, `role: "system"`)
- Each conversation message line: `{ id, role, content, timestamp }`
- `addMessage()`: load → push → save (single-threaded, safe for concurrent writes across different sessions)
- Runtime metadata (`lastProvider`, `lastModel`) persisted in the meta line

### 3.8 Knowledge Base
- `server/services/knowledge.ts` parses the overview used by the web UI; AI file operations still use the tool layer
- `knowledge_base/index.md`: global index (markdown table: name, description, link)
- `knowledge_base/<name>/index.md`: per-base index (description + file list)
- AI reads `index.md` → selects base → reads base's `index.md` → reads specific files
- `GET /api/knowledge` parses `index.md` table and lists directories for the UI overview

### 3.9 Config (`src/config/`)
- **Schema** (Zod): `providers` map, `defaultProvider`, `defaultModel`, `defaultThinkingEffort`, `maxTokens`, `contextMaxTokens`, `contextMaxMessages`, `injectRootIndex`（默认 `false`，注入 `reflections/_index.md`，超 1 KB 则放弃注入）, `maxToolCalls`, `server` (port/host), `fs.policy` (readable/writable/denied) 及其旧字段 `fs.allowedDirs`/`fs.allowedFiles`（仅字段兼容）, `tools` (tavily, trilium), `compaction` (provider/model/thinkingEffort). Each model may declare native `thinking` values.
- **Supported providers**: `zai` (智谱), `dashscope` (阿里百炼), `deepseek`, `commandcode`
- **Thinking levels**: the UI always adds `none`; each model's `thinking` list supplies provider-native values (for example, DeepSeek `high` / `max`). `none` is sent explicitly as that provider's disable parameter.
- **`$AICLAW_DATA_DIR`** must be set via `.env` file, no default fallback

---

## 4. Request Flow

### 4.1 Chat Message Flow

```
Browser                          Server                          LLM
  │                                │                              │
  │  WS: chatMessage               │                              │
  │  {sessionId, content,          │                              │
  │   provider, model,             │                              │
  │   thinkingEffort}              │                              │
  │ ────────────────────────────►  │                              │
  │                                │  load session + messages     │
  │                                │  load system prompt          │
  │                                │  truncate context            │
  │  WS: chatStart                 │                              │
  │ ◄────────────────────────────  │                              │
  │                                │  POST /v1/chat/completions ──►
  │                                │  (non-streaming, with tools) │
  │                                │                              │
  │                                │  ◄── response                │
  │                                │  (content or tool_calls)     │
  │  WS: chatReasoning (if any)    │                              │
  │ ◄────────────────────────────  │                              │
  │                                │                              │
  │  [if tool_calls]:              │                              │
  │  WS: toolCall {name, input}    │                              │
  │ ◄────────────────────────────  │                              │
  │                                │  executeTool()               │
  │  WS: toolResult {name,         │                              │
  │       content, isError}        │                              │
  │ ◄────────────────────────────  │                              │
  │                                │  POST /v1/chat/completions ──►
  │                                │  (with tool results)         │
  │                                │  ... loop until content ...  │
  │                                │                              │
  │  WS: chatChunk (full text)     │                              │
  │ ◄────────────────────────────  │                              │
  │                                │                              │
  │  WS: chatEnd {usage}           │                              │
  │ ◄────────────────────────────  │                              │
  │                                │  persist messages to JSONL   │
  │                                │  append usage to usage_temp  │
```

### 4.2 Session Switch Flow

```
Browser                                                  Server
  │                                                        │
  │  selectSession(B)                                      │
  │  - save A's streaming state (if generating)            │
  │  - switch currentSessionId → B                         │
  │  - render B's chat area                                │
  │                                                        │
  │  WS: joinSession {sessionId: B}                        │
  │ ────────────────────────────────────────────────────►  │
  │                                                        │
  │  WS: sessionLoaded {session: B's messages}             │
  │ ◄────────────────────────────────────────────────────  │
  │                                                        │
  │  [Meanwhile, A continues generating in background]     │
  │  [Server broadcasts A's chunks to any client           │
  │   subscribed to A — currently dropped by frontend]     │
```

---

## 5. Data Formats

### 5.1 Conversation (JSONL)
```jsonl
{"id":"meta","role":"system","content":"","timestamp":"2026-04-24T...","metadata":{"title":"My Chat","sessionId":"abc123","createdAt":"...","updatedAt":"...","lastProvider":"zai","lastModel":"GLM-4.7"}}
{"id":"msg1","role":"user","content":"你好","timestamp":"2026-04-24T..."}
{"id":"msg2","role":"assistant","content":"你好！有什么可以帮你的？","timestamp":"2026-04-24T..."}
```

### 5.2 Configuration (`config.json`)
```json
{
  "providers": {
    "zai": {
      "apiKey": "your-api-key",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "models": [
        {"id": "GLM-4.7", "label": "GLM-4.7", "thinking": ["enabled"]},
        {"id": "GLM-4.5-Air", "label": "GLM-4.5-Air"}
      ]
    },
    "dashscope": {
      "apiKey": "",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "models": [
        {"id": "qwen3.6-27b", "label": "qwen3.6-27b"}
      ]
    }
  },
  "defaultProvider": "zai",
  "defaultModel": "GLM-4.7",
  "defaultThinkingEffort": "low",
  "maxTokens": 4096,
  "contextMaxTokens": 100000,
  "contextMaxMessages": 0,
  "injectRootIndex": false,
  "maxToolCalls": 10,
  "server": { "port": 3000, "host": "127.0.0.1" },
  "fs": {
    "policy": {
      "readable": ["reflections", "people", "knowledge_base", "distill", "pending", "agents"],
      "writable": ["people", "distill", "pending", "agents"],
      "denied": [
        "conversations", "logs", "files/prompts", "files/app_state.json",
        "agents/main/AGENT.md", "agents/main/user.md"
      ]
    }
  },
  "compaction": {
    "provider": "zai",
    "model": "glm-4.5-air",
    "thinkingEffort": "none"
  }
}
```

---

## 6. Frontend Architecture

The browser UI uses native ES modules without a frontend framework or bundler. `index.html` contains only the stable page skeleton and loads `styles/*` plus `js/main.js`.

### 6.1 State Management
- `state.js` creates one plain state object for connection, session, chat and stable DOM references.
- `main.js` creates the state and explicitly passes it to features; modules do not add business state to `window`.
- `features/sessions.js` owns `sessionCache`, preserving DOM and streaming state when switching sessions.
- Settings, usage, permissions, pickers and document browsing keep short-lived state inside their feature modules.

### 6.2 Rendering
- `dom.js` creates the chat shell and binds controls for the current session.
- `render/messages.js` renders historical messages and restart controls.
- `render/streaming.js` updates reasoning, tool calls, chunks, cursors and typing placeholders.
- `markdown.js` renders Markdown and math content; `format.js` contains escaping and number formatting helpers.
- `features/documents.js`, `features/people.js`, `features/reflections.js`, `features/pending.js`, `pickers.js`, `permissions.js`, `usage.js`, `knowledge.js` and `settings.js` own their respective UI behavior.
- 「文档 / 人物 / 心得」是**左栏面板切换**（`state.panel`），与会话无关：切面板不换会话、也不持久化。切到心得时，右栏 `#chat-panel` 复用同一会话，只带 `reflectionPreview.previewPath` 作上下文。
- 心得面板底部有「待应用」入口（带角标），点开是覆盖层：左列表、右侧 base/proposed 对比与「应用 / 丢弃」。

### 6.3 Communication
- `websocket.js` owns one connection, JSON serialization and a 3-second reconnect timer. It has no feature imports. Auth uses a first-frame `{ type: "auth", token }` message. The client is ready only after `connected`.
- `api.js` centralizes JSON HTTP requests used by session, chat and picker features; attaches Bearer token from `access-token.js`.
- `main.js` checks `/health.authRequired` and may show a simple token gate before boot.
- `features/chat.js` routes server messages and controls the current streaming response; reconnect joins the current session again.

---

## 7. Security

### 7.1 File System Sandbox（三档 ACL）
- All file tool paths resolved relative to `$AICLAW_DATA_DIR/`
- 判定顺序：`denied`（最高）→ `writable` → `readable` → 拒绝
- 默认：`readable = reflections, people, knowledge_base, distill, pending, agents`；`writable = people, distill, pending, agents`
- `denied` 只约束 **Agent 工具**，不约束系统（系统提示词、`app_state.json` 由服务端自己读写）
- `reflections/` 与 `knowledge_base/` 对 AI **只读**：改动必须先 `propose_change` 落 `pending/`，由用户在「待应用」确认
- `move` 的源与目标都必须在 `writable` 内；`delete` 在 `people/`、`agents/`、`distill/` 走归档
- 旧配置的 `fs.allowedDirs` / `fs.allowedFiles` 映射为 `readable ∪ writable`（仅字段兼容，不做路径兼容）

### 7.2 API Keys
- Stored in `config.json`, loaded by server at startup
- Never logged; `aiclaw status` only reports whether an API key is set

### 7.3 Network
- Server binds `127.0.0.1` by default (localhost only)
- Optional `server.accessToken` + `server.corsOrigins` for multi-client (LAN / phone / App)
- Non-loopback bind without `accessToken` is rejected at startup
- Details: [multi_client.md](./multi_client.md)
- Phone client lives in [`mobile/`](../../mobile/README.md). Desktop UI stays in `src/server/public/` because the server serves that directory directly.

---

## 8. Testing

- **Vitest** for unit/integration tests
- Test files alongside source: `*.test.ts`
- `test-utils.ts`: `setupTestDir()` / `cleanupTestDir()` for filesystem-based tests
- Key test files: `config/index.test.ts`, `session/index.test.ts`, `chat/index.test.ts`, `chat/context-budget.test.ts`, `chat/compaction.test.ts`, `server/index.test.ts`, `server/auth.test.ts`, `tools/file-tools.test.ts`, `tools/executor.test.ts`, `tools/fs-policy.test.ts`, `tools/acl.test.ts`, `index/indexer.test.ts`, `pending/pending.test.ts`, `people/people.test.ts`, `app-state/index.test.ts`
- 索引失败分支（`index/indexer.test.ts` 第 28、29 条）**通过注入 `IndexWriter` stub 触发**，不 mock `node:fs`：要断言的组合状态是「文件已写好、索引没写成功」，mock fs 会连带拦掉正文写入。
