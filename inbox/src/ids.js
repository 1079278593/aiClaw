import crypto from "node:crypto";

/** Time-sortable-ish unique id for messages */
export function newMessageId() {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(6).toString("hex");
  return `msg_${t}_${r}`;
}
