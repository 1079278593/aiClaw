/**
 * Common LLM provider types
 */

import type { Message } from "../types/index.js";
import type { LLMTool, LLMToolCall } from "../tools/types.js";

export type { LLMTool, LLMToolCall };

/**
 * A yielded item from a streaming completion
 */
export interface NormalizedUsage {
  inputTokens: number;           // prompt_tokens 总数
  cachedReadTokens?: number;     // prompt 缓存命中
  cachedWriteTokens?: number;    // prompt 缓存写入
  billingOutputTokens: number;   // completion_tokens（计费用，含 thinking）
  thinkingTokens?: number;       // reasoning_tokens
  outputTokens: number;          // completion_tokens - thinkingTokens（纯输出）
}

export interface UsageRecord extends NormalizedUsage {
  model: string;
  provider: string;
  timestamp: string;
  sessionId: string;
  cost: number;
}

export type StreamChunk =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCallDelta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "usage"; usage: NormalizedUsage };

/** Return value of stream() — finish reason and assembled tool calls (if any) */
export interface StreamFinish {
  finish_reason: string;
  tool_calls?: LLMToolCall[];
}

/**
 * Non-streaming completion response (normalized)
 */
export interface CompletionResponse {
  content: string | null;
  tool_calls?: LLMToolCall[];
  finish_reason: string;
  reasoning_content?: string;
  usage?: NormalizedUsage;
}

/**
 * Options shared by all providers
 */
export interface CompletionOptions {
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  timeout?: number;
  tools?: LLMTool[];
  thinkingEffort?: string;
  thinkingParams?: Record<string, unknown>;
  responseFormat?: { type: "json_object" | "text" };
  signal?: AbortSignal;
}

/**
 * LLM provider interface — every provider must implement this
 */
export interface LLMProvider {
  /**
   * Non-streaming completion (used in agentic tool-call loop)
   */
  complete(
    apiKey: string,
    messages: Message[],
    options?: CompletionOptions,
  ): Promise<CompletionResponse>;

  /**
   * Streaming completion — yields chunks (content, reasoning, toolCallDelta, usage),
   * returns finish metadata with assembled tool_calls
   */
  stream(
    apiKey: string,
    messages: Message[],
    options?: CompletionOptions,
  ): AsyncGenerator<StreamChunk, StreamFinish, unknown>;
}
