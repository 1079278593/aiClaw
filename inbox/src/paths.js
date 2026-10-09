import path from "node:path";
import { InboxPathError } from "./errors.js";

/** Safe thread folder name: no slashes, no .., reasonable length */
export function sanitizeThreadId(raw) {
  const name = String(raw ?? "").trim();
  if (!name) throw new InboxPathError("会话名称不能为空");
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new InboxPathError("会话名称非法");
  }
  if (name.startsWith(".")) throw new InboxPathError("会话名称不能以 . 开头");
  if (name.length > 80) throw new InboxPathError("会话名称过长");
  return name;
}

export function getChatsRoot(dataDir) {
  return path.resolve(dataDir, "inputs", "chats");
}

export function resolveThreadDir(chatsRoot, threadId) {
  const id = sanitizeThreadId(threadId);
  const resolvedRoot = path.resolve(chatsRoot);
  const dir = path.resolve(resolvedRoot, id);
  if (dir !== resolvedRoot && !dir.startsWith(resolvedRoot + path.sep)) {
    throw new InboxPathError("路径越界");
  }
  return { id, dir };
}

export function timestampSlug(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `_${pad(date.getMilliseconds(), 3)}`
  );
}
