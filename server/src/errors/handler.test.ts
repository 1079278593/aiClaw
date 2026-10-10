/**
 * Error handler tests
 */

import { describe, it, expect, vi } from "vitest";
import {
  AiClawError,
  ConfigError,
  LLMError,
  FileSystemError,
  isError,
  isAiClawError,
} from "./index.js";
import { ToolError } from "../tools/fs-policy.js";
import { ErrorHandler, withErrorHandling, withSyncErrorHandling } from "./handler.js";

describe("Custom Errors", () => {
  it("should create AiClawError with code", () => {
    const error = new AiClawError("Test error", "TEST_CODE");
    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.name).toBe("AiClawError");
  });

  it("should create AiClawError with details", () => {
    const details = { key: "value" };
    const error = new AiClawError("Test error", "TEST_CODE", details);
    expect(error.details).toEqual(details);
  });

  it("should create ConfigError", () => {
    const error = new ConfigError("Config is invalid");
    expect(error.code).toBe("CONFIG_ERROR");
    expect(error.name).toBe("ConfigError");
  });

  it("should create LLMError", () => {
    const error = new LLMError("LLM call failed");
    expect(error.code).toBe("LLM_ERROR");
    expect(error.name).toBe("LLMError");
  });

  it("should create FileSystemError", () => {
    const error = new FileSystemError("File not found");
    expect(error.code).toBe("FS_ERROR");
    expect(error.name).toBe("FileSystemError");
  });

  it("should create ToolError (from fs-policy) and be instanceof AiClawError", () => {
    const error = new ToolError("Tool execution failed");
    expect(error.code).toBe("TOOL_ERROR");
    expect(error.name).toBe("ToolError");
    expect(error instanceof AiClawError).toBe(true);
  });
});

describe("Error Type Guards", () => {
  it("should identify Error instances", () => {
    const error = new Error("Test");
    expect(isError(error)).toBe(true);
    expect(isError("not an error")).toBe(false);
  });

  it("should identify AiClawError instances", () => {
    const error = new AiClawError("Test", "TEST");
    expect(isAiClawError(error)).toBe(true);
    expect(isAiClawError(new Error("Test"))).toBe(false);
  });
});

describe("ErrorHandler", () => {
  it("should create ErrorHandler", () => {
    const handler = new ErrorHandler();
    expect(handler).toBeDefined();
  });

  it("should handle errors without throwing", () => {
    const handler = new ErrorHandler({ exitOnError: false });
    const error = new Error("Test error");
    expect(() => handler.handle(error)).not.toThrow();
  });

  it("should handle AiClawError", () => {
    const mockLogger = {
      error: vi.fn(),
    };
    const handler = new ErrorHandler({ logger: mockLogger as any });
    const error = new AiClawError("Test error", "TEST_CODE");

    handler.handle(error);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Test error"),
      expect.objectContaining({
        code: "TEST_CODE",
      })
    );
  });
});

describe("Error Handling Wrappers", () => {
  it("withSyncErrorHandling should catch and log errors", () => {
    const mockLogger = {
      error: vi.fn(),
    };

    const fn = vi.fn(() => {
      throw new Error("Test error");
    });

    const wrappedFn = withSyncErrorHandling(fn, { logger: mockLogger as any });

    expect(() => wrappedFn()).toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("withSyncErrorHandling should pass through results", () => {
    const fn = vi.fn(() => 42);
    const wrappedFn = withSyncErrorHandling(fn);

    const result = wrappedFn();
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalled();
  });

  it("withErrorHandling should handle async errors", async () => {
    const mockLogger = {
      error: vi.fn(),
    };

    const asyncFn = vi.fn(async () => {
      throw new Error("Async error");
    });

    const wrappedFn = withErrorHandling(asyncFn, { logger: mockLogger as any });

    await expect(wrappedFn()).rejects.toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
