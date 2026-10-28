/**
 * Command Code LLM provider
 *
 * OpenAI Chat Completions style API (https://commandcode.ai/docs/provider):
 *   - thinking off: reasoning_effort: "off"（模型需支持关闭思考，强制思考模型会 400）
 *   - assistant 历史消息回传 reasoning_content（与其他 provider 一致，实测接受）
 *   - GET {baseUrl}/models 返回实时模型清单
 */

import type { Message } from "../../types/index.js";
import { LLMError } from "../../errors/index.js";
import { logger } from "../../logger/index.js";
import type { LLMToolCall } from "../../tools/types.js";
import type {
  LLMProvider,
  CompletionResponse,
  CompletionOptions,
  StreamChunk,
  StreamFinish,
  NormalizedUsage,
} from "../types.js";
import { DEFAULT_TIMEOUT, mapMessage, fetchWithRetry } from "./shared.js";

export const COMMANDCODE_ENDPOINT = "https://api.commandcode.ai/provider/v1";

export const COMMANDCODE_DEFAULT_MODEL = "z-ai/glm-5.3-flash";

function mapUsage(raw: CommandCodeRawUsage): NormalizedUsage {
  const thinkingTokens = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  const promptDetails = raw.prompt_tokens_details;
  return {
    inputTokens: raw.prompt_tokens,
    outputTokens: Math.max(0, raw.completion_tokens - thinkingTokens),
    billingOutputTokens: raw.completion_tokens,
    thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined,
    cachedReadTokens: promptDetails?.cached_tokens ?? promptDetails?.cache_read_input_tokens,
    cachedWriteTokens: promptDetails?.cache_write_tokens ?? promptDetails?.created_cache_tokens,
  };
}

interface CommandCodeRawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    created_cache_tokens?: number;
    cache_read_input_tokens?: number;
  };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface CommandCodeChunk {
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      /** 思考文本：不同模型字段名不同（glm-5.3-flash 用 reasoning_content，flashx 用 reasoning） */
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_text?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: string | null;
  }>;
  usage?: CommandCodeRawUsage | null;
}

interface CommandCodeResponse {
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: LLMToolCall[];
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
    };
    finish_reason: string;
  }>;
  usage?: CommandCodeRawUsage;
}

/** 思考字段兼容：网关不同模型的回传字段名不统一 */
function pickReasoning(...candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) {
    if (c) return c;
  }
  return undefined;
}

export class CommandCodeProvider implements LLMProvider {
  readonly label = "commandcode";

  async complete(apiKey: string, messages: Message[], options: CompletionOptions = {}): Promise<CompletionResponse> {
    const {
      model = COMMANDCODE_DEFAULT_MODEL,
      baseUrl = COMMANDCODE_ENDPOINT,
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
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...thinkingParams,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };

    const res = await fetchWithRetry(
      this.label,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      timeout,
      options.signal,
    );

    const data = (await res.json()) as CommandCodeResponse;
    const choice = data.choices[0];

    return {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
      finish_reason: choice.finish_reason,
      reasoning_content: pickReasoning(choice.message.reasoning_content, choice.message.reasoning, choice.message.reasoning_text),
      usage: data.usage ? mapUsage(data.usage) : undefined,
    };
  }

  async *stream(
    apiKey: string,
    messages: Message[],
    options: CompletionOptions = {},
  ): AsyncGenerator<StreamChunk, StreamFinish, unknown> {
    const {
      model = COMMANDCODE_DEFAULT_MODEL,
      baseUrl = COMMANDCODE_ENDPOINT,
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

    const res = await fetchWithRetry(
      this.label,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      timeout,
      options.signal,
    );

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
        if (options.signal?.aborted) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data: ")) continue;
          const data = t.slice(6);
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data) as CommandCodeChunk;
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            const reasoningText = pickReasoning(delta?.reasoning_content, delta?.reasoning, delta?.reasoning_text);
            if (reasoningText) yield { type: "reasoning", text: reasoningText };
            if (delta?.content) yield { type: "content", text: delta.content };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallsMap.get(tc.index) ?? { id: "", name: "", arguments: "" };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallsMap.set(tc.index, existing);
                yield {
                  type: "toolCallDelta",
                  index: tc.index,
                  id: tc.id,
                  name: tc.function?.name,
                  arguments: tc.function?.arguments,
                };
              }
            }
            if (parsed.usage) yield { type: "usage", usage: mapUsage(parsed.usage) };
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
          } catch {
            logger.warn("[commandcode] 无法解析 chunk");
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
