import type { WebSocket } from "ws";
import type { ProviderName } from "../config/index.js";
import type { TokenSpeedSnapshot } from "../chat/speed.js";
import type { ContextBudgetReport } from "../chat/context-budget.js";
import type { NormalizedUsage } from "../llm/types.js";
import type { Message } from "../types/index.js";

export type Client = {
  ws: WebSocket;
  sessionId?: string;
  isAlive: boolean;
  writePermOpen: boolean;
  /** 已放行的「会话内一次授权」key（plan §3.5）。 */
  grants?: Set<string>;
  tenantId?: string;
};

export type ClientMessage =
  | { type: "ping" }
  | { type: "auth"; token: string }
  | { type: "joinSession"; sessionId: string; requestId?: string }
  | {
      type: "chatMessage";
      sessionId: string;
      content: string;
      images?: Array<{ url: string; path?: string }>;
      provider: ProviderName;
      model: string;
      thinkingEffort?: string;
      previewPath?: string;
      selectedPreviewText?: string;
      threadPath?: string;
      captureJob?: "organize";
    }
  | { type: "toolPermissionResponse"; requestId: string; allowed: boolean }
  | { type: "setWritePermission"; enabled: boolean }
  | { type: "cancelChat"; sessionId: string };

export type UsageSummary = NormalizedUsage & {
  model: string;
  provider: string;
  cost: number;
};

export type ServerMessage =
  | { type: "connected"; message: string }
  | { type: "pong" }
  | {
      type: "sessionLoaded";
      requestId?: string;
      session: {
        id: string;
        title: string;
        messages: Message[];
        lastProvider?: string;
        lastModel?: string;
        lastThinkingEffort?: string;
      };
    }
  | { type: "chatStart"; sessionId: string; runId: string; sequence: number; userMessageId?: string }
  | { type: "chatChunk"; sessionId: string; runId: string; sequence: number; chunk: string }
  | { type: "chatReasoning"; sessionId: string; runId: string; sequence: number; chunk: string }
  | {
      type: "chatEnd";
      sessionId: string;
      runId: string;
      sequence: number;
      fullResponse: string;
      usage?: UsageSummary;
      contextUsage?: UsageSummary;
      tokenSpeed?: TokenSpeedSnapshot;
      /** 上下文预算占比报表（§6.5）。飞行前估算值，UI 可与实际 prompt_tokens 对照。 */
      budget?: ContextBudgetReport;
    }
  | {
      type: "chatSpeed";
      sessionId: string;
      runId: string;
      sequence: number;
      tokensPerSecond: number;
      totalTokens: number;
      elapsedMs: number;
      ts: number;
    }
  | { type: "chatCancelled"; sessionId: string; runId: string; sequence: number; fullResponse: string }
  | { type: "toolCall"; sessionId: string; runId: string; sequence: number; name: string; input: Record<string, unknown>; callId: string }
  | { type: "toolResult"; sessionId: string; runId: string; sequence: number; name: string; content: string; isError: boolean; callId: string }
  | { type: "toolPermissionRequest"; sessionId: string; runId: string; sequence: number; requestId: string; toolName: string; risk?: "safe" | "session" | "always"; details: Record<string, string> }
  | { type: "error"; message: string; sessionId?: string; runId?: string; sequence?: number };
