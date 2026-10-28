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
import { getInstallRoot, getPaths, pathExists } from "../config/paths.js";
import { defaultTenantDir, migrateLegacyInstall } from "../tenant/migrate.js";
import { runWithTenant } from "../tenant/store.js";
import { createUser, loadUsers, revokeUser, rotateUser } from "../tenant/users.js";

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
      const installRoot = getInstallRoot();
      const migrated = await migrateLegacyInstall(installRoot);
      const tenantDir = defaultTenantDir(installRoot);
      const config = await initConfig(tenantDir);
      const paths = getPaths(tenantDir);
      const logger = getLogger(getPaths(installRoot).logs);
      if (migrated === "migrated") {
        logger.info(`Moved existing data into ${tenantDir}`);
      }

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
      const state = await runWithTenant({ id: "default", base: tenantDir }, () => startServer({
        port,
        host,
        config,
        tenant: { id: "default", base: tenantDir },
      }));

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
    const installRoot = getInstallRoot();
    const legacyConfig = getPaths(installRoot).config;
    const tenantDir = defaultTenantDir(installRoot);
    const paths = getPaths(tenantDir);
    const logger = getLogger(getPaths(installRoot).logs);
    try {
      if (await pathExists(legacyConfig)) {
        logger.error(`Legacy data is still at ${installRoot}. Run '${BRAND_SLUG} tenant migrate-legacy' first.`);
        process.exit(1);
      }
      const config = await initConfig(tenantDir);
      logger.info("Configuration initialized successfully");
      logger.info(`Config location: ${paths.config}`);
      if (!config.providers[config.defaultProvider]?.apiKey) {
        logger.info("请在该文件中填入默认模型提供商的 API Key。");
      }
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
    const installRoot = getInstallRoot();
    const tenantDir = defaultTenantDir(installRoot);
    const tenantConfig = getPaths(tenantDir).config;
    const legacyConfig = getPaths(installRoot).config;
    const usingTenant = await pathExists(tenantConfig);
    const paths = getPaths(usingTenant ? tenantDir : installRoot);
    const logger = getLogger(getPaths(installRoot).logs);
    try {
      if ((await pathExists(legacyConfig)) && !usingTenant) {
        console.log(`Legacy layout at ${installRoot}. Run '${BRAND_SLUG} tenant migrate-legacy' or '${BRAND_SLUG} start'.`);
      }
      const configExists = await pathExists(paths.config);
      const config = await loadConfigWithoutApiKey(paths.base);
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

const tenantCmd = program.command("tenant").description("Tenant data layout");

tenantCmd
  .command("migrate-legacy")
  .description("Move config and data from the install root into tenants/<user>")
  .option("-u, --user <id>", "Tenant id", "default")
  .action(async (options: { user: string }) => {
    const installRoot = getInstallRoot();
    const logger = getLogger(getPaths(installRoot).logs);
    try {
      const result = await migrateLegacyInstall(installRoot, options.user);
      const dest = defaultTenantDir(installRoot, options.user);
      if (result === "migrated") logger.info(`Migrated data to ${dest}`);
      else if (result === "already") logger.info(`Tenant data already at ${dest}`);
      else logger.info(`No legacy config.json at ${installRoot}. Nothing to move.`);
    } catch (error) {
      logger.error(`Migration failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

const userCmd = program.command("user").description("Tenant access tokens");

userCmd
  .command("create <id>")
  .description("Create a user and print the access token once")
  .option("-l, --label <text>", "Label", "")
  .action(async (id: string, options: { label: string }) => {
    const installRoot = getInstallRoot();
    const logger = getLogger(getPaths(installRoot).logs);
    try {
      const token = await createUser(id, options.label, installRoot);
      await initConfig(defaultTenantDir(installRoot, id));
      console.log(`\nUser '${id}' created. Copy this access token now; it is not shown again:\n`);
      console.log(token);
      console.log(`\nData directory: ${defaultTenantDir(installRoot, id)}`);
      console.log("Put the provider API key in that directory's config.json.\n");
    } catch (error) {
      logger.error((error as Error).message);
      process.exit(1);
    }
  });

userCmd
  .command("revoke <id>")
  .description("Disable a user's access token")
  .action(async (id: string) => {
    const logger = getLogger(getPaths(getInstallRoot()).logs);
    try {
      await revokeUser(id);
      logger.info(`Revoked user '${id}'.`);
    } catch (error) {
      logger.error((error as Error).message);
      process.exit(1);
    }
  });

userCmd
  .command("rotate <id>")
  .description("Replace a user's access token and print the new one once")
  .action(async (id: string) => {
    const logger = getLogger(getPaths(getInstallRoot()).logs);
    try {
      const token = await rotateUser(id);
      console.log(`\nNew access token for '${id}'. Copy it now; it is not shown again:\n`);
      console.log(token);
      console.log("");
    } catch (error) {
      logger.error((error as Error).message);
      process.exit(1);
    }
  });

userCmd
  .command("list")
  .description("List users without revealing tokens")
  .action(async () => {
    const users = await loadUsers();
    if (users.length === 0) {
      console.log("No users.");
      return;
    }
    for (const user of users) {
      const state = user.disabled ? "disabled" : "active";
      console.log(`${user.id}\t${state}\t${user.label}\t${user.createdAt}`);
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
