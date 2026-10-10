/**
 * Tools module - initialization and exports
 */

import type { Config } from "../config/index.js";
import { resolveAllowedDirs, resolveAllowedFiles } from "./fs-policy.js";
import { createFileTools } from "./file-tools.js";
import { createWebTools } from "./web-tools.js";
import { createTriliumTools } from "./trilium-tools.js";
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
  const allowedDirs = resolveAllowedDirs(config.fs.allowedDirs);
  const allowedFiles = resolveAllowedFiles(config.fs.allowedFiles);

  for (const tool of createFileTools(allowedDirs, allowedFiles)) {
    registerTool(tool);
  }

  for (const tool of createWebTools(config.tools.tavily)) {
    registerTool(tool);
  }

  for (const tool of createTriliumTools(config.tools.trilium)) {
    registerTool(tool);
  }
}
