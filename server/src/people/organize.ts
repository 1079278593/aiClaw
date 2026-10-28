import { appendDigest, writeProfileIfComplete, type PersonEntry } from "./store.js";

export const ARCHIVE_MARKER = "<<<档案>>>";

export const ORGANIZE_USER_TEXT = "整理目前新增的内容。";

const ORGANIZE_INSTRUCTIONS = `已有历史简报在下面。这次只附上次整理末尾之后的原文。每条带 speaker 或 kind：speaker=me 是用户自己，speaker=them 是对方，kind=note 是用户写下的自述。

根据下面这次的原文，写历史简报。
保留重要信息，表达中心意思。废话和没有实质内容的不收录。改变了经过的短句要留下。
只写原文里有的，不补充原文没有的内容。人名和数字用原文里的词。
标明属于自己或对方的，仍属于这一方。自述不要写成某一方说的话。
已有历史简报不要重写。这次只写新增的一段，接在后面。

若档案需要按这次原文修改，在简报正文之后以 <<<档案>>> 开头，给出完整档案。不需要改就不要写档案。
不要修改 entries.jsonl。`;

export function visibleBeforeMarker(raw: string): string {
  const index = raw.indexOf(ARCHIVE_MARKER);
  if (index !== -1) return raw.slice(0, index);
  let hold = 0;
  const max = Math.min(ARCHIVE_MARKER.length - 1, raw.length);
  for (let size = max; size > 0; size -= 1) {
    if (ARCHIVE_MARKER.startsWith(raw.slice(-size))) {
      hold = size;
      break;
    }
  }
  return raw.slice(0, raw.length - hold);
}

export function splitOrganizeReply(raw: string): { brief: string; profile: string | null } {
  const index = raw.indexOf(ARCHIVE_MARKER);
  if (index === -1) return { brief: raw.trim(), profile: null };
  const profile = raw.slice(index + ARCHIVE_MARKER.length).trim();
  return { brief: raw.slice(0, index).trim(), profile: profile || null };
}

export function renderEntries(entries: PersonEntry[]): string {
  if (entries.length === 0) return "（没有新的原文）";
  return entries.map((entry) => {
    const who = entry.kind === "note" ? "kind=note" : `speaker=${entry.speaker}`;
    return `[${entry.id}] ${who}\n${entry.text}`;
  }).join("\n\n");
}

export async function applyOrganizeResult(id: string, rawReply: string, lastAt: string | undefined, userDataDir?: string): Promise<{ brief: string }> {
  const { brief, profile } = splitOrganizeReply(rawReply);
  if (!brief || !lastAt) throw new Error(brief ? "没有新的原文" : "整理没有写出正文");
  await appendDigest(id, brief, lastAt, userDataDir);
  if (profile) {
    try {
      await writeProfileIfComplete(id, profile, userDataDir);
    } catch {
      // 档案栏目不齐、称呼为空或与别人冲突时，保留原来的档案。
    }
  }
  return { brief };
}

export function buildOrganizeMaterials(digest: string, profile: string, entries: PersonEntry[]): string {
  return [
    ORGANIZE_INSTRUCTIONS,
    "",
    "已有历史简报：",
    digest.trim() || "（空）",
    "",
    "现有档案：",
    profile.trim() || "（空）",
    "",
    "这次的原文：",
    renderEntries(entries),
  ].join("\n");
}
