/**
 * Shared retry/timeout/fetch logic for OpenAI-compatible providers.
 */

import type { Message } from "../../types/index.js";
import { LLMError } from "../../errors/index.js";
import { logger } from "../../logger/index.js";
import type { LLMToolCall } from "../../tools/types.js";

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

export const DEFAULT_TIMEOUT = 180000;

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function retryDelay(attempt: number, cfg: RetryConfig) {
  return Math.min(cfg.initialDelayMs * Math.pow(cfg.backoffMultiplier, attempt), cfg.maxDelayMs);
}

/**
 * 剥离 ImagePart 中的内部 path 字段（仅用于前端展示与会话持久化，
 * 不应发送给 provider）。返回新对象，不修改原消息。
 */
function stripImagePath(content: Message["content"]): Message["content"] {
  if (!Array.isArray(content)) return content;
  return content.map((part) =>
    part.type === "image_url"
      ? { type: "image_url", image_url: { url: part.image_url.url } }
      : part,
  );
}

export function mapMessage(m: Message): {
  role: string;
  content: Message["content"];
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
  reasoning_content?: string;
} {
  const content = stripImagePath(m.content);
  if (m.role === "tool") return { role: "tool", content, tool_call_id: m.tool_call_id };
  if (m.tool_calls)
    return {
      role: m.role,
      content,
      tool_calls: m.tool_calls,
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    };
  return { role: m.role, content };
}

export async function fetchWithRetry(
  label: string,
  url: string,
  init: Omit<RequestInit, "signal">,
  timeout: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= DEFAULT_RETRY.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // If externally cancelled, stop retrying immediately
        if (externalSignal?.aborted) throw externalSignal.reason ?? new DOMException("已取消", "AbortError");
        const delay = retryDelay(attempt - 1, DEFAULT_RETRY);
        logger.info(`[${label}] 重试第 ${attempt}/${DEFAULT_RETRY.maxRetries} 次，等待 ${delay}ms`);
        await sleep(delay);
      }

      const signal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout);

      const res = await fetch(url, { ...init, signal });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LLMError(`LLM API 错误: ${res.status} ${res.statusText} - ${text}`, {
          code: "llm_api_error",
          status: res.status,
          body: text,
        });
      }

      return res;
    } catch (err) {
      lastError = err as Error;
      if (err instanceof LLMError) {
        const status = (err.details as { status?: number })?.status;
        if (status === 401 || status === 404) throw err;
      }
      // 外部取消：让 AbortError 继续向上传播
      if (err instanceof Error && err.name === "AbortError") {
        if (externalSignal?.aborted) throw err;
        throw new LLMError(`LLM 请求超时，超过 ${timeout}ms`, { code: "llm_timeout_error" });
      }
      if (attempt === DEFAULT_RETRY.maxRetries) break;
    }
  }
  throw new LLMError(`LLM 请求失败，${DEFAULT_RETRY.maxRetries} 次重试后仍然失败: ${lastError?.message}`, {
    code: "llm_retry_failed",
    originalError: lastError,
  });
}
