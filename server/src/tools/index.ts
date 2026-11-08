/**
 * Tools module - initialization and exports
 */

import type { Config } from "../config/index.js";
import { getFsPolicy } from "../config/schema.js";
import { createFileTools } from "./file-tools.js";
import { createWebTools } from "./web-tools.js";
import { createTriliumTools } from "./trilium-tools.js";
import { createProposeChangeTool } from "./propose-change.js";
import { createDistillTool } from "./distill.js";
import { createRememberTool } from "./remember.js";
import { registerTool, clearTools } from "./registry.js";

export { getTools } from "./registry.js";
export { executeTool } from "./executor.js";
export type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

/**
 * Initialize all tools with the current config.
 * Clears any previously registered tools first.
 */
export function initTools(config: Config): void {
  clearTools();
  // Keep dirs relative. File tools resolve them against the active tenant at call time.
  const policy = getFsPolicy(config);

  for (const tool of createFileTools(policy)) {
    registerTool(tool);
  }

  registerTool(createProposeChangeTool(policy));
  registerTool(createRememberTool(policy));
  registerTool(createDistillTool(policy, config));

  for (const tool of createWebTools(config.tools.tavily)) {
    registerTool(tool);
  }

  for (const tool of createTriliumTools(config.tools.trilium)) {
    registerTool(tool);
  }
}
