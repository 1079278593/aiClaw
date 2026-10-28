/**
 * z.ai (智谱 GLM) LLM provider
 *
 * OpenAI-compatible API. Thinking is enabled via:
 *   { "thinking": { "type": "enabled" } }
 * GLM-4.7 / GLM-5 have thinking on by default; pass "disabled" to turn it off.
 */

import type { Message } from "../../types/index.js";
import { LLMError } from "../../errors/index.js";
import { logger } from "../../logger/index.js";
import type { LLMToolCall } from "../../tools/types.js";
import type { LLMProvider, CompletionResponse, CompletionOptions, StreamChunk, StreamFinish, NormalizedUsage } from "../types.js";
import { DEFAULT_TIMEOUT, mapMessage, fetchWithRetry } from "./shared.js";

export const ZAI_ENDPOINTS = {
  global: "https://api.z.ai/api/paas/v4",
  cn: "https://open.bigmodel.cn/api/paas/v4",
} as const;

function mapUsage(raw: ZaiRawUsage): NormalizedUsage {
  const thinkingTokens = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: Math.max(0, raw.completion_tokens - thinkingTokens),
    billingOutputTokens: raw.completion_tokens,
    thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined,
    cachedReadTokens: raw.prompt_tokens_details?.cached_tokens,
    cachedWriteTokens: raw.prompt_tokens_details?.cache_write_tokens,
  };
}

interface ZaiRawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ZaiChunk {
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason: string | null;
  }>;
  usage?: ZaiRawUsage;
}

interface ZaiResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: LLMToolCall[]; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage: ZaiRawUsage;
}

export class ZaiProvider implements LLMProvider {
  readonly label = "zai";

  async complete(apiKey: string, messages: Message[], options: CompletionOptions = {}): Promise<CompletionResponse> {
    const {
      model = "glm-5",
      baseUrl = ZAI_ENDPOINTS.global,
      maxTokens = 4096,
      timeout = DEFAULT_TIMEOUT,
      tools,
      thinkingParams,
      responseFormat,
    } = options;

    const body = {
      model,
      messages: messages.map(mapMessage),
      max_tokens: maxTokens,
      stream: false,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...thinkingParams,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };

    logger.debug(`[zai] complete`, { model, messageCount: messages.length });
    const res = await fetchWithRetry(this.label, `${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeout, options.signal);

    const data = (await res.json()) as ZaiResponse;
    const choice = data.choices[0];
    logger.debug(`[zai] complete done`, { tokens: data.usage?.total_tokens, finish: choice.finish_reason });

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
      model = "glm-5",
      baseUrl = ZAI_ENDPOINTS.global,
      maxTokens = 4096,
      timeout = DEFAULT_TIMEOUT,
      tools,
      thinkingParams,
    } = options;

    const body = {
      model,
      messages: messages.map(mapMessage),
      max_tokens: maxTokens,
      stream: true,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...thinkingParams,
    };

    logger.debug(`[zai] stream`, { model, messageCount: messages.length, hasTools: !!(tools?.length) });
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
            const parsed = JSON.parse(data) as ZaiChunk;
            const delta = parsed.choices[0]?.delta;
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
            if (parsed.choices[0]?.finish_reason) {
              finishReason = parsed.choices[0].finish_reason;
              if (parsed.usage) yield { type: "usage", usage: mapUsage(parsed.usage) };
            }
          } catch { logger.warn(`[zai] 无法解析 chunk`); }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Assemble tool calls from accumulated deltas
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
