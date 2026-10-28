/**
 * Tool system types
 */

import type { MessageContentPart } from "../types/index.js";

/**
 * Context passed to tools when executing
 */
export interface ToolContext {
  sessionId: string;
  sessionTitle: string;
  /** Whether the active model can consume images. read gates its image branch on this. */
  supportsImages?: boolean;
}

/**
 * Result returned by a tool execution
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Multimodal parts (e.g. images) to append to the tool result message sent to the LLM.
   * `content` stays a text summary for the UI; these parts are only added when the
   * active model supports images. Requires a provider that accepts media in tool messages
   * (verified working on DashScope 阿里百炼).
   */
  imageParts?: MessageContentPart[];
}

/**
 * JSON Schema object (subset used for tool input schemas)
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: unknown[];
}

/**
 * Tool definition - the interface every tool must implement
 */
export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context?: ToolContext): Promise<ToolResult>;
}

/**
 * OpenAI-compatible function definition (for LLM request)
 */
export interface LLMToolFunction {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LLMTool {
  type: "function";
  function: LLMToolFunction;
}

/**
 * Tool call from LLM response
 */
export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}
