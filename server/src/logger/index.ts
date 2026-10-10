/**
 * Logger module - Basic logging with console and file output
 */

import fs from "node:fs";
import path from "node:path";
import {
  BRAND_SLUG,
  dataDirEnvMissingMessage,
  getDataDirFromEnv,
} from "../brand.js";
import { LogLevel, LOG_LEVELS, RESET_COLOR, type LogLevelConfig } from "./levels.js";
export { LogLevel } from "./levels.js";

export interface LoggerOptions {
  minLevel?: LogLevel;
  enableConsole?: boolean;
  enableFile?: boolean;
  logDir?: string;
}

export class Logger {
  private minLevel: LogLevel;
  private enableConsole: boolean;
  private enableFile: boolean;
  private logDir: string;
  private currentLogFile: string | null = null;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel ?? LogLevel.INFO;
    this.enableConsole = options.enableConsole ?? true;
    this.enableFile = options.enableFile ?? true;
    this.logDir = options.logDir ?? "./logs";

    if (this.enableFile) {
      this.ensureLogDir();
      this.setCurrentLogFile();
    }
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private setCurrentLogFile(): void {
    const date = new Date().toISOString().split("T")[0];
    this.currentLogFile = path.join(this.logDir, `${BRAND_SLUG}-${date}.log`);
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  private formatMessage(
    level: LogLevel,
    config: LogLevelConfig,
    message: string,
    data?: Record<string, unknown>
  ): string {
    const timestamp = this.formatTimestamp();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    return `[${timestamp}] [${config.name}] ${message}${dataStr}`;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (level < this.minLevel) {
      return;
    }

    const config = LOG_LEVELS[level];
    const formattedMessage = this.formatMessage(level, config, message, data);

    // Console output with colors
    if (this.enableConsole) {
      const colorizedMessage = `${config.color}[${config.name}]${RESET_COLOR} ${message}`;
      if (data) {
        console.log(`${colorizedMessage}`, data);
      } else {
        console.log(colorizedMessage);
      }
    }

    // File output without colors
    if (this.enableFile && this.currentLogFile) {
      // Update log file if date changed
      this.ensureLogDir();
      this.setCurrentLogFile();
      fs.appendFileSync(this.currentLogFile, formattedMessage + "\n");
    }
  }

  public debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  public verbose(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.VERBOSE, message, data);
  }

  public info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, data);
  }

  public warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, data);
  }

  public error(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, data);
  }

  public setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }
}

// Default logger instance (will be initialized with correct path later)
let defaultLogger: Logger | null = null;

/**
 * Get or create the default logger instance
 * If logDir is provided and logger hasn't been initialized, creates new logger with that directory
 * If logger already exists, returns existing instance (ignores logDir parameter)
 */
export function getLogger(logDir?: string): Logger {
  if (!defaultLogger) {
    // If no logDir provided, use user data directory
    if (!logDir) {
      // Check environment variable (includes .env file)
      const envDir = getDataDirFromEnv();
      if (envDir) {
        logDir = path.join(envDir, "logs");
      } else {
        // No default - require explicit configuration
        throw new Error(dataDirEnvMissingMessage());
      }
    }
    defaultLogger = new Logger({ logDir });
  }
  return defaultLogger;
}

// Export a default logger instance for backward compatibility
// Delegates to getLogger() which uses user data directory by default
// Use a getter to defer initialization until first use
export const logger = new Proxy({} as Logger, {
  get(_target, prop) {
    return getLogger()[prop as keyof Logger];
  },
});

// Export level constants for convenience
export const LogLevels = LogLevel;
