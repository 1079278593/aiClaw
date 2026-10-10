import type { WebSocket } from "ws";
import type { ProviderName } from "../config/index.js";
import type { NormalizedUsage } from "../llm/types.js";
import type { Message } from "../types/index.js";

export type Client = {
  ws: WebSocket;
  sessionId?: string;
  isAlive: boolean;
  writePermOpen: boolean;
};

export type ClientMessage =
  | { type: "ping" }
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
  | { type: "chatEnd"; sessionId: string; runId: string; sequence: number; fullResponse: string; usage?: UsageSummary; contextUsage?: UsageSummary }
  | { type: "chatCancelled"; sessionId: string; runId: string; sequence: number; fullResponse: string }
  | { type: "toolCall"; sessionId: string; runId: string; sequence: number; name: string; input: Record<string, unknown>; callId: string }
  | { type: "toolResult"; sessionId: string; runId: string; sequence: number; name: string; content: string; isError: boolean; callId: string }
  | { type: "toolPermissionRequest"; sessionId: string; runId: string; sequence: number; requestId: string; toolName: string; details: Record<string, string> }
  | { type: "error"; message: string; sessionId?: string; runId?: string; sequence?: number };
