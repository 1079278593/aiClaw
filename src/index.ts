/**
 * aiClaw - Main entry point
 *
 * Forwards to CLI for command processing
 */

import { main as cliMain } from "./cli/index.js";

// Run CLI
cliMain().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// Re-exports
export { logger } from "./logger/index.js";
export * from "./types/index.js";
export * from "./errors/index.js";
export * from "./errors/handler.js";
export * from "./config/index.js";
export * from "./session/index.js";
export * from "./chat/index.js";
export * from "./llm/index.js";
export * from "./server/index.js";
