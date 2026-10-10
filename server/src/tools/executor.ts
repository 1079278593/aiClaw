/**
 * Tool executor - finds and runs a tool by name
 */

import { logger } from "../logger/index.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  tools: ToolDefinition[],
  context?: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    logger.warn(`Tool not found: ${name}`);
    return { content: `Tool not found: ${name}`, isError: true };
  }

  try {
    logger.debug(`Executing tool: ${name}`, { input, context });
    const result = await tool.execute(input, context);
    logger.debug(`Tool result: ${name}`, { isError: result.isError });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Tool execution error: ${name} - ${message}`);
    return { content: `Tool error: ${message}`, isError: true };
  }
}
