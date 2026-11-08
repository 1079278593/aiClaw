/**
 * 授权分级（plan §3.5）：风险由「路径 + 操作」决定，不由工具名决定。
 *
 * | 级别 | 范围 |
 * |------|------|
 * | safe    | read / list / grep、propose_change、distill 与 pending 的写 |
 * | session | people 的常规写入、agents/main 的 runtime/focus/longterm |
 * | always  | 删除、跨目录 move、直接写 knowledge_base、批量写入 |
 *
 * 逐次打断会让用户永久打开 writePermOpen，防护归零；所以只有 always 每次都问。
 */

import path from "node:path";

export type ToolRisk = "safe" | "session" | "always";

export const SAFE_TOOLS = new Set(["read", "list", "grep", "propose_change"]);
export const WRITE_TOOLS = new Set(["write", "edit", "delete", "move", "web_search", "web_fetch", "remember", "distill"]);
/** 一次操作涉及超过这个数量的文件就算批量，必须每次确认。 */
export const BATCH_THRESHOLD = 3;

/** 知识区：Agent 只能用 propose_change，直接写一律每次确认。 */
const KNOWLEDGE_ROOTS = ["reflections", "knowledge_base"];
/** 会话内一次授权的可写区。 */
const SESSION_WRITE_ROOTS = ["people", "distill", "pending", "agents"];

function normalize(value: unknown): string {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.?\//, "");
}

function underRoot(relPath: string, root: string): boolean {
  return relPath === root || relPath.startsWith(`${root}/`);
}

function topDir(relPath: string): string {
  return relPath.split("/")[0] ?? "";
}

/** 一次 tool 调用涉及的相对路径集合（write/edit/delete 一个；move 两个）。 */
function touchedPaths(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === "move") return [normalize(input.path), normalize(input.new_path)].filter(Boolean);
  if (toolName === "write" || toolName === "edit") {
    const list = Array.isArray(input.paths) ? input.paths : [input.path];
    return list.map(normalize).filter(Boolean);
  }
  if (toolName === "delete") return [normalize(input.path)].filter(Boolean);
  return [];
}

/**
 * 判定一次工具调用的授权级别。
 *
 * `confirm: "never"` 把 session 档降为 safe（always 档不变）；
 * `confirm: "always"` 把 session 档升为 always。
 */
export function classifyToolRisk(
  toolName: string,
  input: Record<string, unknown> = {},
  confirm: "never" | "session" | "always" = "session",
): ToolRisk {
  if (!WRITE_TOOLS.has(toolName)) return "safe";
  if (toolName === "web_search" || toolName === "web_fetch") return "always";
  // 记忆写入落 `agents/main/**`，属 session 档（plan §3.5 表格最后一行）。
  // `distill` 只写蒸馏区（AI 可写区），同一会话确认一次即可。
  if (toolName === "remember" || toolName === "distill") {
    return confirm === "never" ? "safe" : confirm === "always" ? "always" : "session";
  }

  const paths = touchedPaths(toolName, input);
  if (paths.length === 0) return "always";

  // 删除任何用户内容：每次确认。
  if (toolName === "delete") return "always";
  // 批量操作：每次确认。
  if (paths.length > BATCH_THRESHOLD) return "always";

  const writePaths = toolName === "move" ? paths : [paths[0]];

  // move 跨目录（顶层区不同）等于「搬到别处」= 删除 + 写入，按最严处理。
  if (toolName === "move" && paths.length === 2 && topDir(paths[0]) !== topDir(paths[1])) {
    return "always";
  }

  // 直接写知识区（应用 pending 以外的路径）：每次确认。
  if (writePaths.some((rel) => KNOWLEDGE_ROOTS.some((root) => underRoot(rel, root)))) {
    return "always";
  }

  const inSessionRoot = writePaths.every((rel) => SESSION_WRITE_ROOTS.some((root) => underRoot(rel, root)));
  if (!inSessionRoot) return "always";

  // people 常规写入与 agents 的 runtime/focus/longterm 属会话档；distill/pending 更宽松。
  const onlyLoose = writePaths.every((rel) => underRoot(rel, "distill") || underRoot(rel, "pending"));
  if (onlyLoose) return "safe";

  return confirm === "never" ? "safe" : "always" === confirm ? "always" : "session";
}

/** 会话内是否已经为本档授权过。 */
export function sessionGrantKey(toolName: string, input: Record<string, unknown>): string {
  const paths = touchedPaths(toolName, input);
  const roots = [...new Set(paths.map((rel) => topDir(rel)))].sort();
  return roots.join(",");
}

/**
 * 是否需要弹框。
 * `granted` 是该连接已经放行的 session 档 key 集合（同一会话同类操作只问一次）。
 */
export function needsConfirmation(
  risk: ToolRisk,
  granted: Set<string>,
  key: string,
): boolean {
  if (risk === "safe") return false;
  if (risk === "always") return true;
  return !granted.has(key);
}

/** 测试/诊断用：把路径归类成可读的区域名。 */
export function areaOf(relPath: string): string {
  const rel = normalize(relPath);
  if (!rel) return "";
  return path.posix.dirname(rel) === "." ? rel : topDir(rel);
}
