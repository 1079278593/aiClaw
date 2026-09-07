# hyxClaw - Technical Architecture

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
│   └── compaction.ts     # Session compaction (LLM-summarized history)
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
│   ├── web-tools.ts      # Optional Tavily search/fetch
│   ├── trilium-tools.ts  # Optional read-only Trilium tools
│   └── fs-policy.ts      # Path sandboxing (resolveAllowedDirs, assertPathAllowed)
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
│   └── index.ts          # lastActiveSessionId (restored on page load)
├── logger/               # Logging (tslog wrapper)
│   └── index.ts          # Logger class, getLogger(), module-level logger proxy
├── errors/               # Error classes
│   ├── index.ts          # HyxClawError, ConfigError, LLMError, FileSystemError, ToolError
│   └── handler.ts        # ErrorHandler, withErrorHandling() wrappers
├── types/                # Shared TypeScript types
│   └── index.ts          # Message, Session, MessageRole, re-exports from config/llm
├── test-utils.ts         # Test helpers (setupTestDir, cleanupTestDir)
├── test-setup.ts         # Vitest global setup
└── index.ts              # Entry point → forwards to CLI
```

### 2.2 User Data Directory (`$HYXCLAW_DATA_DIR`)

```
$HYXCLAW_DATA_DIR/
├── config.json                          # Main configuration
├── conversations/                       # Session history (JSONL)
│   ├── <sessionId>.jsonl
│   └── ...
├── conversation_archive/                # Compaction archives
│   └── <sessionId>_<timestamp>.jsonl
├── inputs/                              # Staging area for knowledge base files
├── knowledge_base/                      # Knowledge base (markdown + files)
│   ├── index.md                         # Global index of all knowledge bases
│   └── <base-name>/
│       ├── index.md                     # Per-base index (description + file list)
│       └── ...                          # Knowledge files
├── files/                               # AI workspace
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
- `hyxclaw start` — Start web server
- `hyxclaw init` — Initialize the data directory and templates
- `hyxclaw status` — Check configuration, data directory and startup readiness

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
| GET | `/health` | Health check |
| GET | `/api/config` | Available providers, models, defaults, `triliumEnabled` |
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create session |
| GET | `/api/sessions/:id` | Load session messages |
| PATCH | `/api/sessions/:id` | Rename session |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/sessions/:id/compact` | Compact session |
| POST | `/api/sessions/:id/truncate` | Restart from a user message |
| GET | `/api/app-state` | Load UI state |
| GET | `/api/usage/stats` | Aggregated token usage |
| GET | `/api/usage/daily` | Daily token usage |
| POST | `/api/usage/flush` | Archive pending usage records |
| GET | `/api/knowledge` | Knowledge base overview |
| GET | `/api/commands` | Search configured commands |
| GET | `/api/files` | Search allowed local files and, if enabled, Trilium notes |
| GET/PUT | `/api/documents/content` | Read or update a text document (Trilium paths are read-only) |
| GET | `/api/documents/tree` | Browse document roots (`knowledge_base`, `inputs`, optional `trilium`) |

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
- **System prompt**: `loadSystemPrompt()` loads `agent_system_prompt.txt` and appends a real-time `今天的日期是YYYY/MM/DD` date line; the date line is always present even if the file is absent
- **Compaction**: `compactSession()` — sends full history to LLM, saves summary as new session, archives original JSONL

### 3.4 LLM (`src/llm/`)
- **Provider interface** (`LLMProvider`): `complete(apiKey, messages, options)` → `CompletionResponse`
- **Provider implementations**: `ZaiProvider`, `DashScopeProvider`
- Both use raw `fetch` to OpenAI-compatible `/v1/chat/completions` endpoints
- `CompletionOptions`: `model`, `baseUrl`, `temperature`, `maxTokens`, `thinkingEffort`, `tools?`
- `CompletionResponse`: `content`, `finish_reason`, `tool_calls?`, `reasoning_content?`, `usage` (normalized)

### 3.5 Tools (`src/tools/`)
- **Registry**: module-level `tools[]` array, `registerTool()`, `getTools()`, `initTools()` clears then re-registers
- **Built-in tools**: `list`, `read`, `write`, `edit`, `grep`, `move`, `delete` — file operations under `$HYXCLAW_DATA_DIR/`. `read` handles both text and images: a text file returns its content (optional `offset`/`limit` line slicing; capped at 2000 lines / 50 KiB by default, soft-truncated with a notice on overflow), while an allowlisted PNG/JPEG/GIF/WebP file is returned as a multimodal tool result. The image branch is gated on the active model's vision support (`context.supportsImages`); non-vision models get a text error instead of the bytes.
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
- **Schema** (Zod): `providers` map, `defaultProvider`, `defaultModel`, `defaultThinkingEffort`, `maxTokens`, `contextMaxTokens`, `contextMaxMessages`, `maxToolCalls`, `server` (port/host), `fs` (allowedDirs/allowedFiles), `tools` (tavily, trilium), `compaction` (provider/model/thinkingEffort). Each model may declare native `thinking` values.
- **Supported providers**: `zai` (智谱), `dashscope` (阿里百炼)
- **Thinking levels**: the UI always adds `none`; each model's `thinking` list supplies provider-native values (for example, DeepSeek `high` / `max`). `none` is sent explicitly as that provider's disable parameter.
- **`$HYXCLAW_DATA_DIR`** must be set via `.env` file, no default fallback

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
  "maxToolCalls": 10,
  "server": { "port": 3000, "host": "127.0.0.1" },
  "fs": {
    "allowedDirs": ["inputs", "knowledge_base", "files"],
    "allowedFiles": []
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
- `dom.js` creates the chat workspace and binds controls for the current session.
- `render/messages.js` renders historical messages and restart controls.
- `render/streaming.js` updates reasoning, tool calls, chunks, cursors and typing placeholders.
- `markdown.js` renders Markdown and math content; `format.js` contains escaping and number formatting helpers.
- `features/documents.js`, `pickers.js`, `permissions.js`, `usage.js`, `knowledge.js` and `settings.js` own their respective UI behavior.

### 6.3 Communication
- `websocket.js` owns one connection, JSON serialization and a 3-second reconnect timer. It has no feature imports.
- `api.js` centralizes JSON HTTP requests used by session, chat and picker features.
- `features/chat.js` routes server messages and controls the current streaming response; reconnect joins the current session again.

---

## 7. Security

### 7.1 File System Sandbox
- All file tool paths resolved relative to `$HYXCLAW_DATA_DIR/`
- `assertPathAllowed()` checks resolved path is within `fs.allowedDirs` or matches `fs.allowedFiles`
- Default: `inputs/`, `knowledge_base/`, `files/`

### 7.2 API Keys
- Stored in `config.json`, loaded by server at startup
- Never logged; `hyxclaw status` only reports whether an API key is set

### 7.3 Network
- Server binds `127.0.0.1` by default (localhost only)

---

## 8. Testing

- **Vitest** for unit/integration tests
- Test files alongside source: `*.test.ts`
- `test-utils.ts`: `setupTestDir()` / `cleanupTestDir()` for filesystem-based tests
- Key test files: `config/index.test.ts`, `session/index.test.ts`, `chat/index.test.ts`, `chat/compaction.test.ts`, `server/index.test.ts`, `tools/file-tools.test.ts`, `tools/executor.test.ts`, `tools/fs-policy.test.ts`
