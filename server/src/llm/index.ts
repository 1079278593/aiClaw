/**
 * LLM provider factory
 */

export type { LLMProvider, CompletionResponse, CompletionOptions, StreamChunk, StreamFinish } from "./types.js";
export type { LLMTool, LLMToolCall } from "../tools/types.js";

import type { LLMProvider } from "./types.js";
import { ZaiProvider } from "./providers/zai.js";
import { DashScopeProvider } from "./providers/dashscope.js";
import { DeepSeekProvider } from "./providers/deepseek.js";

export type LLMProviderName = "zai" | "dashscope" | "deepseek";

export function createProvider(provider: LLMProviderName): LLMProvider {
  switch (provider) {
    case "zai": return new ZaiProvider();
    case "dashscope": return new DashScopeProvider();
    case "deepseek": return new DeepSeekProvider();
    default: throw new Error(`Unknown LLM provider: ${provider as string}`);
  }
}
