/**
 * Logger tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { Logger, LogLevel } from "./index.js";

describe("Logger", () => {
  const testLogDir = "./test-logs";

  beforeEach(() => {
    // Clean up test logs directory
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test logs directory
    if (fs.existsSync(testLogDir)) {
      fs.rmSync(testLogDir, { recursive: true });
    }
  });

  it("should create logger with default options", () => {
    const logger = new Logger();
    expect(logger).toBeDefined();
  });

  it("should respect minimum log level", () => {
    const logger = new Logger({
      minLevel: LogLevel.WARN,
      enableConsole: false,
      enableFile: false,
    });

    // Should not throw - these are below min level
    expect(() => logger.debug("debug")).not.toThrow();
    expect(() => logger.info("info")).not.toThrow();
  });

  it("should write logs to file", () => {
    const logger = new Logger({
      minLevel: LogLevel.DEBUG,
      enableConsole: false,
      enableFile: true,
      logDir: testLogDir,
    });

    logger.info("Test message");

    // Check if log file was created
    const files = fs.readdirSync(testLogDir);
    expect(files.length).toBeGreaterThan(0);

    // Check if log file contains the message
    const logFile = files[0];
    const logContent = fs.readFileSync(`${testLogDir}/${logFile}`, "utf-8");
    expect(logContent).toContain("Test message");
    expect(logContent).toContain("INFO");
  });

  it("should write all log levels", () => {
    const logger = new Logger({
      minLevel: LogLevel.DEBUG,
      enableConsole: false,
      enableFile: true,
      logDir: testLogDir,
    });

    logger.debug("Debug message");
    logger.verbose("Verbose message");
    logger.info("Info message");
    logger.warn("Warn message");
    logger.error("Error message");

    // Get log file content
    const files = fs.readdirSync(testLogDir);
    const logContent = fs.readFileSync(`${testLogDir}/${files[0]}`, "utf-8");

    expect(logContent).toContain("DEBUG");
    expect(logContent).toContain("VERBOSE");
    expect(logContent).toContain("INFO");
    expect(logContent).toContain("WARN");
    expect(logContent).toContain("ERROR");
  });

  it("should include data in log output", () => {
    const logger = new Logger({
      minLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: true,
      logDir: testLogDir,
    });

    logger.info("Test with data", { key: "value", number: 42 });

    const files = fs.readdirSync(testLogDir);
    const logContent = fs.readFileSync(`${testLogDir}/${files[0]}`, "utf-8");

    expect(logContent).toContain("key");
    expect(logContent).toContain("value");
    expect(logContent).toContain("42");
  });
});
