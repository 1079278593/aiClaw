/**
 * Log level definitions
 */

export enum LogLevel {
  DEBUG = 0,
  VERBOSE = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

export interface LogLevelConfig {
  name: string;
  color: string;
  emoji: string;
}

export const LOG_LEVELS: Record<LogLevel, LogLevelConfig> = {
  [LogLevel.DEBUG]: { name: "DEBUG", color: "\x1b[36m", emoji: "🔍" }, // Cyan
  [LogLevel.VERBOSE]: { name: "VERBOSE", color: "\x1b[35m", emoji: "📝" }, // Magenta
  [LogLevel.INFO]: { name: "INFO", color: "\x1b[32m", emoji: "ℹ️" }, // Green
  [LogLevel.WARN]: { name: "WARN", color: "\x1b[33m", emoji: "⚠️" }, // Yellow
  [LogLevel.ERROR]: { name: "ERROR", color: "\x1b[31m", emoji: "❌" }, // Red
};

export const RESET_COLOR = "\x1b[0m";
