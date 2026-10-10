/**
 * Tool registry - simple module-level store for registered tools
 */

import type { ToolDefinition } from "./types.js";

const tools: ToolDefinition[] = [];

export function registerTool(tool: ToolDefinition): void {
  const existing = tools.findIndex((t) => t.name === tool.name);
  if (existing >= 0) {
    tools[existing] = tool; // replace if already registered
  } else {
    tools.push(tool);
  }
}

export function getTools(): ToolDefinition[] {
  return tools;
}

export function clearTools(): void {
  tools.length = 0;
}
