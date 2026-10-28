/**
 * DashScope (Qwen) LLM provider
 *
 * OpenAI-compatible API with:
 *   - enable_thinking: boolean
 *   - thinking_budget: number
 * Stream usage arrives in a dedicated chunk where choices = []
 */

import type { Message } from "../../types/index.js";
import { LLMError } from "../../errors/index.js";
import { logger } from "../../logger/index.js";
import type { LLMToolCall } from "../../tools/types.js";
import type { LLMProvider, CompletionResponse, CompletionOptions, StreamChunk, StreamFinish, NormalizedUsage } from "../types.js";
import { DEFAULT_TIMEOUT, mapMessage, fetchWithRetry } from "./shared.js";

export const DASHSCOPE_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
function mapUsage(raw: DashScopeRawUsage): NormalizedUsage {
  const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  const textTokens = raw.completion_tokens_details?.text_tokens ?? raw.completion_tokens;
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: Math.max(0, textTokens - reasoningTokens),
    billingOutputTokens: raw.completion_tokens,
    thinkingTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    cachedReadTokens: raw.prompt_tokens_details?.cached_tokens,
    cachedWriteTokens: raw.prompt_tokens_details?.cache_write_tokens,
  };
}

interface DashScopeRawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { text_tokens?: number; cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { text_tokens?: number; reasoning_tokens?: number };
}

interface DashScopeChunk {
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: string | null;
  }>;
  usage?: DashScopeRawUsage;
}

interface DashScopeResponse {
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: LLMToolCall[]; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage?: DashScopeRawUsage;
}

export class DashScopeProvider implements LLMProvider {
  readonly label = "dashscope";

  async complete(apiKey: string, messages: Message[], options: CompletionOptions = {}): Promise<CompletionResponse> {
    const {
      model = "qwen-plus",
      baseUrl = DASHSCOPE_ENDPOINT,
      maxTokens = 4096,
      timeout = DEFAULT_TIMEOUT,
      tools,
      thinkingParams,
      responseFormat,
    } = options;
    const body = {
      model,
      messages: messages.map(mapMessage),
      max_completion_tokens: maxTokens,
      stream: false,
      ...thinkingParams,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };

    const res = await fetchWithRetry(this.label, `${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeout, options.signal);

    const data = (await res.json()) as DashScopeResponse;
    const choice = data.choices[0];

    return {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
      finish_reason: choice.finish_reason,
      reasoning_content: choice.message.reasoning_content,
      usage: data.usage ? mapUsage(data.usage) : undefined,
    };
  }

  async *stream(apiKey: string, messages: Message[], options: CompletionOptions = {}): AsyncGenerator<StreamChunk, StreamFinish, unknown> {
    const {
      model = "qwen-plus",
      baseUrl = DASHSCOPE_ENDPOINT,
      maxTokens = 4096,
      timeout = DEFAULT_TIMEOUT,
      tools,
      thinkingParams,
    } = options;
    const body = {
      model,
      messages: messages.map(mapMessage),
      max_completion_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...thinkingParams,
    };

    const res = await fetchWithRetry(this.label, `${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeout, options.signal);

    if (!res.body) throw new LLMError("响应 body 为空", { code: "llm_empty_response" });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finishReason = "";
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data: ")) continue;
          const data = t.slice(6);
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data) as DashScopeChunk;
            if (!parsed.choices?.length && parsed.usage) {
              yield { type: "usage", usage: mapUsage(parsed.usage) };
              continue;
            }
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            if (delta?.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };
            if (delta?.content) yield { type: "content", text: delta.content };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallsMap.get(tc.index) ?? { id: "", name: "", arguments: "" };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallsMap.set(tc.index, existing);
                yield { type: "toolCallDelta", index: tc.index, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
              }
            }
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
          } catch {
            logger.warn("[dashscope] 无法解析 chunk");
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const tool_calls: LLMToolCall[] = [...toolCallsMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));

    return { finish_reason: finishReason || "stop", ...(tool_calls.length > 0 ? { tool_calls } : {}) };
  }
}
