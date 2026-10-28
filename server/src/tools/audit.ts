/**
 * One line when a write tool runs. No file contents.
 */

import { logger } from "../logger/index.js";
import { currentTenant } from "../tenant/store.js";

const WRITE_TOOLS = new Set(["write", "edit", "move", "delete"]);

export function auditToolPath(name: string, input: Record<string, unknown>): string {
  const oneLine = (value: unknown) => String(value ?? "").replace(/[\r\n]/g, " ").slice(0, 200);
  if (name === "move") return `${oneLine(input.path)} -> ${oneLine(input.new_path)}`;
  return oneLine(input.path ?? input.file ?? "");
}

export function auditWriteTool(name: string, input: Record<string, unknown>, ok: boolean): void {
  if (!WRITE_TOOLS.has(name)) return;
  const tenant = currentTenant()?.id ?? "-";
  logger.info(`audit tenant=${tenant} tool=${name} path=${auditToolPath(name, input)} ok=${ok}`);
}
