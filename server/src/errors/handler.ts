/**
 * Error handler with logging integration
 */

import type { Logger } from "../logger/index.js";
import { isAiClawError, isError, type AiClawError } from "./index.js";

export interface ErrorHandlerOptions {
  logger?: Logger;
  exitOnError?: boolean;
}

export class ErrorHandler {
  private logger?: Logger;
  private exitOnError: boolean;

  constructor(options: ErrorHandlerOptions = {}) {
    this.logger = options.logger;
    this.exitOnError = options.exitOnError ?? false;
  }

  public handle(error: unknown, context?: string): void {
    const ctx = context ? `[${context}] ` : "";

    if (isAiClawError(error)) {
      this.handleAiClawError(error, ctx);
    } else if (isError(error)) {
      this.handleGenericError(error, ctx);
    } else {
      this.handleUnknownError(error, ctx);
    }

    if (this.exitOnError) {
      process.exit(1);
    }
  }

  private handleAiClawError(error: AiClawError, ctx: string): void {
    const logData = {
      code: error.code,
      details: error.details,
      stack: error.stack,
    };

    this.logger?.error(`${ctx}${error.message}`, logData);
  }

  private handleGenericError(error: Error, ctx: string): void {
    this.logger?.error(`${ctx}${error.message}`, {
      name: error.name,
      stack: error.stack,
    });
  }

  private handleUnknownError(error: unknown, ctx: string): void {
    this.logger?.error(`${ctx}Unknown error`, {
      error: String(error),
    });
  }

  public setLogger(logger: Logger): void {
    this.logger = logger;
  }
}

// Try-catch wrapper utility
export type AsyncFunction = (...args: unknown[]) => Promise<unknown>;

export function withErrorHandling<T extends AsyncFunction>(
  fn: T,
  options: ErrorHandlerOptions = {}
): T {
  return (async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      const handler = new ErrorHandler(options);
      handler.handle(error, fn.name);
      throw error; // Re-throw after logging
    }
  }) as T;
}

// Sync version
export type SyncFunction = (...args: unknown[]) => unknown;

export function withSyncErrorHandling<T extends SyncFunction>(
  fn: T,
  options: ErrorHandlerOptions = {}
): T {
  return ((...args: unknown[]) => {
    try {
      return fn(...args);
    } catch (error) {
      const handler = new ErrorHandler(options);
      handler.handle(error, fn.name);
      throw error;
    }
  }) as T;
}
