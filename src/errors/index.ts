/**
 * Custom error types
 */

export class AiClawError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AiClawError";
    Error.captureStackTrace?.(this, AiClawError);
  }
}

export class ConfigError extends AiClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", details);
    this.name = "ConfigError";
  }
}

export class LLMError extends AiClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "LLM_ERROR", details);
    this.name = "LLMError";
  }
}

export class FileSystemError extends AiClawError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "FS_ERROR", details);
    this.name = "FileSystemError";
  }
}

export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

export function isAiClawError(error: unknown): error is AiClawError {
  return error instanceof AiClawError;
}
