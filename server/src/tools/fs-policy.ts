/**
 * File system security policy
 * Resolves allowed dirs/files and validates paths against them.
 */

import path from "node:path";
import { getUserDataDir } from "../config/paths.js";
import { AiClawError } from "../errors/index.js";

export class ToolError extends AiClawError {
  constructor(message: string) {
    super(message, "TOOL_ERROR");
    this.name = "ToolError";
  }
}

/**
 * Resolve allowedDirs entries to absolute paths.
 * Relative entries are resolved against getUserDataDir().
 */
export function resolveAllowedDirs(allowedDirs: string[]): string[] {
  const base = getUserDataDir();
  return allowedDirs.map((dir) =>
    path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(base, dir)
  );
}

/**
 * Resolve allowedFiles entries to absolute paths.
 * Relative entries are resolved against getUserDataDir().
 */
export function resolveAllowedFiles(allowedFiles: string[] = []): string[] {
  const base = getUserDataDir();
  return allowedFiles.map((file) =>
    path.isAbsolute(file) ? path.normalize(file) : path.resolve(base, file)
  );
}

/**
 * Assert that filePath is under allowedDirs or exactly matches allowedFiles.
 * Throws ToolError if not allowed.
 */
export function assertPathAllowed(
  filePath: string,
  allowedDirs: string[],
  allowedFiles: string[] = [],
): void {
  const resolved = path.resolve(filePath);

  for (const file of allowedFiles) {
    if (resolved === path.normalize(file)) {
      return;
    }
  }

  for (const dir of allowedDirs) {
    const normalizedDir = path.normalize(dir);
    if (resolved === normalizedDir || resolved.startsWith(normalizedDir + path.sep)) {
      return;
    }
  }

  throw new ToolError(`Path not allowed: ${filePath}`);
}

/**
 * Resolve a tool input path.
 * Only relative paths are accepted; absolute paths are rejected.
 * Relative paths are resolved against getUserDataDir().
 */
export function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    throw new ToolError(`Absolute paths are not allowed: ${inputPath}`);
  }
  return path.resolve(getUserDataDir(), inputPath);
}
