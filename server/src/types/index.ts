/**
 * Basic type definitions
 */

// Message types
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: {
    url: string;
    path?: string;
  };
}

export type MessageContentPart = TextPart | ImagePart;

export interface Message {
  id: string;
  role: MessageRole;
  content: string | MessageContentPart[] | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
  // For assistant messages with tool calls
  tool_calls?: import("../tools/types.js").LLMToolCall[];
  // For tool result messages
  tool_call_id?: string;
  // Persisted to disk; stripped from model input except for DeepSeek with thinking enabled
  reasoning_content?: string;
}

// Session types
export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  lastProvider?: string;
  lastModel?: string;
  lastThinkingEffort?: string;
  /** 人物分析会话。有值时不进全局聊天列表，join 也不写 lastActiveSessionId。 */
  personId?: string;
  /**
   * 是否对本会话做增量折叠（`chat/dialogue-fold.ts`）。
   *
   * 判据只看这个字段，不看会话「是谁」：人物分析会话与心得会话都写 `true`，
   * 普通聊天不写。人物页的多轮判断不能靠 `context-budget.ts` 静默丢轮次，
   * 否则模型会忘掉这个情境里已经做过的取舍（plan_people_reply §5）。
   */
  fold?: boolean;
  /**
   * 本会话勾选的领域（`knowledge_base/<id>/` 目录名），最多 2 个。
   *
   * 只存目录名，不存文件内容：每轮现读 `rules.md` 与 `index.md`，改文件后
   * 下一轮生效。装配与限额见 `chat/experts.ts`（plan_experts §3）。
   */
  experts?: string[];
}

// Config types - re-export from config module
export type { Config, ServerConfig, FSConfig, CompactionConfig, ProviderCredential, ThinkingEffort, ModelOption } from "../config/index.js";

// Tool types — imported from tools module

// LLM types — imported from llm module
