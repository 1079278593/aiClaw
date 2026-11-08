/**
 * File system security policy — 三档 ACL。
 *
 * 判定顺序：denied（最高）→ writable → readable → 拒绝。
 * `denied` 的语义是「Agent 工具不得触碰」，不是「文件不可读」：
 * 系统加载系统提示词、读写 app_state.json 不受此约束（见 plan §3.1）。
 */

import path from "node:path";
import { getUserDataDir } from "../config/paths.js";
import type { FSPolicy } from "../config/schema.js";
import { AiClawError } from "../errors/index.js";

export class ToolError extends AiClawError {
  constructor(message: string) {
    super(message, "TOOL_ERROR");
    this.name = "ToolError";
  }
}

export type FsAccess = "read" | "write";

const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;

/** 纯词法地折叠 `.` / `..`，用于不改动语义地比较 Windows 风格路径。 */
function collapseSegments(input: string): string {
  const parts = input.replaceAll("\\", "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** 绝对路径（含 Windows 盘符形式）原样规范化；只有真正相对的条目才相对数据目录解析。 */
function resolvePolicyEntry(entry: string): string {
  if (path.isAbsolute(entry)) return path.normalize(entry);
  if (WINDOWS_ABS_RE.test(entry)) return collapseSegments(entry);
  return path.resolve(getUserDataDir(), entry);
}

/**
 * 解析策略里的条目。
 * 绝对条目（含 Windows 盘符形式）原样保留，相对条目相对 getUserDataDir() 解析。
 */
export function resolvePolicyEntries(entries: string[] = []): string[] {
  return entries.map(resolvePolicyEntry);
}

/** 兼容旧调用点（file-tools 曾经传 allowedDirs / allowedFiles）。 */
export const resolveAllowedDirs = resolvePolicyEntries;
export const resolveAllowedFiles = resolvePolicyEntries;

/** 统一成可比较形式：Windows 风格先做词法折叠，其余走 path.resolve。 */
function toCompare(value: string): string {
  const normalized = WINDOWS_ABS_RE.test(value)
    ? collapseSegments(value)
    : path.resolve(value).replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "");
}

function matches(target: string, entry: string): boolean {
  const normalizedTarget = target;
  const normalizedEntry = entry.replace(/\/+$/, "");
  return normalizedTarget === normalizedEntry || normalizedTarget.startsWith(`${normalizedEntry}/`);
}

/** 路径是否落在任一条目内（目录前缀或精确文件）。 */
export function pathMatchesAny(filePath: string, entries: string[] = []): boolean {
  const target = toCompare(filePath);
  return resolvePolicyEntries(entries).some((entry) => matches(target, toCompare(entry)));
}

export interface FsPolicyCheck {
  /** 相对数据目录的路径，用于报错与审计。 */
  relativePath: string;
  /** 命中的档位，未命中为 null。 */
  tier: "denied" | "writable" | "readable" | null;
  allowed: boolean;
}

/** 判定一个路径在某操作下的权限档位，不抛异常。 */
export function checkFsPolicy(
  filePath: string,
  access: FsAccess,
  policy: FSPolicy,
): FsPolicyCheck {
  const base = getUserDataDir();
  const relativePath = path.relative(base, path.resolve(filePath)).replaceAll("\\", "/");
  const denied = pathMatchesAny(filePath, policy.denied);
  const writable = pathMatchesAny(filePath, policy.writable);
  const readable = pathMatchesAny(filePath, policy.readable);
  const tier = denied
    ? "denied"
    : access === "write"
      ? (writable ? "writable" : readable ? "readable" : null)
      : (readable || writable ? "readable" : null);
  const allowed = access === "write" ? tier === "writable" : tier === "readable";
  return { relativePath, tier, allowed };
}

/**
 * 断言路径在指定操作下可用。
 *
 * - `read`：readable 或 writable 内，且不在 denied 内；
 * - `write`：必须在 writable 内，且不在 denied 内。
 */
export function assertFsAccess(filePath: string, access: FsAccess, policy: FSPolicy): void {
  const check = checkFsPolicy(filePath, access, policy);
  if (check.allowed) return;
  if (check.tier === "denied") {
    throw new ToolError(`Path denied: ${check.relativePath || filePath}`);
  }
  if (access === "write" && check.tier === "readable") {
    throw new ToolError(`Path is read-only: ${check.relativePath || filePath}（知识区改动请走 propose_change）`);
  }
  throw new ToolError(`Path not allowed: ${check.relativePath || filePath}`);
}

/** 旧签名兼容：allowedDirs / allowedFiles 视为可读写区。 */
export function assertPathAllowed(
  filePath: string,
  allowedDirs: string[],
  allowedFiles: string[] = [],
): void {
  const policy: FSPolicy = {
    readable: [...allowedDirs, ...allowedFiles],
    writable: [...allowedDirs, ...allowedFiles],
    denied: [],
  };
  assertFsAccess(filePath, "read", policy);
}

/**
 * Resolve a tool input path.
 * Only relative paths are accepted; absolute paths are rejected.
 * Relative paths are resolved against getUserDataDir().
 */
export function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath) || WINDOWS_ABS_RE.test(inputPath)) {
    throw new ToolError(`Absolute paths are not allowed: ${inputPath}`);
  }
  const resolved = path.resolve(getUserDataDir(), inputPath);
  const base = path.resolve(getUserDataDir());
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new ToolError(`Path escapes data directory: ${inputPath}`);
  }
  return resolved;
}
