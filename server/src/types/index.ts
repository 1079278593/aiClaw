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
}

// Config types - re-export from config module
export type { Config, ServerConfig, FSConfig, CompactionConfig, ProviderCredential, ThinkingEffort, ModelOption } from "../config/index.js";

// Tool types — imported from tools module

// LLM types — imported from llm module
