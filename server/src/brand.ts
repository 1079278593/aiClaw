/**
 * Product branding — change values here to rename across Node-side code.
 *
 * Conventions:
 * - BRAND_NAME: user-facing display (UI, logs, commit messages)
 * - BRAND_SLUG: CLI binary, package name, file prefixes, localStorage prefix
 * - DATA_DIR_ENV: required env var for the user data directory
 */

export const BRAND_NAME = "aiClaw";
export const BRAND_SLUG = "aiclaw";
export const DATA_DIR_ENV = "AICLAW_DATA_DIR";

export function getDataDirFromEnv(): string | undefined {
  return process.env[DATA_DIR_ENV];
}

export function dataDirEnvMissingMessage(): string {
  return (
    `${DATA_DIR_ENV} environment variable is not set!\n` +
    `Please create a .env file in the project root with:\n` +
    `${DATA_DIR_ENV}=/path/to/your/data/directory\n\n` +
    `See .env.example for reference.`
  );
}
