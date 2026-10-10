/**
 * CLI - Command Line Interface
 *
 * Provides commands for starting the server and managing sessions
 */

import { Command } from "commander";
import { BRAND_NAME, BRAND_SLUG } from "../brand.js";
import { getLogger } from "../logger/index.js";
import { startServer } from "../server/index.js";
import { initConfig, loadConfigWithoutApiKey, getDefaultProviderCredential } from "../config/index.js";
import { getPaths, pathExists } from "../config/paths.js";

const program = new Command();

program
  .name(BRAND_SLUG)
  .description("Personal AI Assistant")
  .version("0.1.0");

/**
 * Start command - runs the web server
 */
program
  .command("start")
  .description(`Start the ${BRAND_NAME} server`)
  .option("-p, --port <number>", "Port to listen on", undefined)
  .option("-h, --host <address>", "Host address to bind to", undefined)
  .action(async (options) => {
    try {
      // Init config (creates default if not exists)
      const config = await initConfig();
      const paths = getPaths();
      const logger = getLogger(paths.logs);

      // Require API key before starting
      const defaultCredential = getDefaultProviderCredential(config);
      if (!defaultCredential.apiKey) {
        logger.error("API Key not set! Please edit config.json and set your LLM API key.");
        logger.error(`Config file: ${paths.config}`);
        process.exit(1);
      }

      // Override port/host if specified (options take precedence over env vars)
      const port = options.port ? parseInt(options.port, 10) : (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined);
      const host = options.host ?? process.env.HOST ?? undefined;

      if (port) {
        config.server.port = port;
      }
      if (host) {
        config.server.host = host;
      }

      // Start server with port/host overrides
      const state = await startServer({
        port,
        host,
        config,
      });

      logger.info(`Web UI: http://${state.host}:${state.port}`);

      // Handle graceful shutdown
      let shuttingDown = false;
      const shutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`Received ${signal}, shutting down...`);
        if (process.platform === "win32" && process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        stopServer(state);
        process.exit(0);
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      if (process.platform === "win32" && process.stdin.isTTY) {
        const readline = await import("node:readline");
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on("keypress", (_str, key) => {
          if (key && key.ctrl && key.name === "c") {
            shutdown("SIGINT");
          }
        });
      }

      // Keep process alive
      logger.info("Press Ctrl+C to stop the server");
    } catch (error) {
      const logger = getLogger(getPaths().logs);
      logger.error(`Failed to start server: ${(error as Error).message}`);
      process.exit(1);
    }
  });

/**
 * Init command - initialize config
 */
program
  .command("init")
  .description("Initialize configuration")
  .action(async () => {
    const paths = getPaths();
    const logger = getLogger(paths.logs);
    try {
      const config = await initConfig();
      logger.info("Configuration initialized successfully");
      logger.info(`Please edit config.json and set your API Key.`);
      logger.info(`Config location: ${paths.config}`);
    } catch (error) {
      logger.error(`Failed to initialize config: ${(error as Error).message}`);
      process.exit(1);
    }
  });

/**
 * Status command - check startup readiness
 */
program
  .command("status")
  .description("Check configuration and startup readiness")
  .action(async () => {
    const paths = getPaths();
    const logger = getLogger(paths.logs);
    try {
      const configExists = await pathExists(paths.config);
      const config = await loadConfigWithoutApiKey();
      const apiKeySet = Boolean(config.providers[config.defaultProvider]?.apiKey);

      console.log(`\n=== ${BRAND_NAME} Status ===`);
      console.log(`Data directory: ${paths.base}`);
      console.log(`Config file: ${configExists ? paths.config : `${paths.config} (not initialized)`}`);
      console.log(`Provider: ${config.defaultProvider}`);
      console.log(`Model: ${config.defaultModel}`);
      console.log(`API key: ${apiKeySet ? "set" : "not set"}`);
      console.log(`Web UI: http://${config.server.host}:${config.server.port}`);
      console.log("");

      if (!configExists) {
        console.log(`Run '${BRAND_SLUG} init' to create the default configuration.`);
      } else if (!apiKeySet) {
        console.log(`Set the API key in ${paths.config} before starting the server.`);
      } else {
        console.log(`Ready to start. Run '${BRAND_SLUG} start'.`);
      }
    } catch (error) {
      logger.error(`Status check failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

/**
 * Main entry point
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  await program.parseAsync(argv);
}

/**
 * Helper to stop server (needed for closure in command handler)
 */
async function stopServer(state: unknown): Promise<void> {
  const { stopServer: stop } = await import("../server/index.js");
  await stop(state as Parameters<typeof stop>[0]);
}

// Run CLI
main().catch((error) => {
  const logger = getLogger(getPaths().logs);
  logger.error("Fatal error", error);
  process.exit(1);
});
