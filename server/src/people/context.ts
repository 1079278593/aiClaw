import { currentBody } from "./profile.js";

const PROFILE_INLINE_LIMIT = 12_000;

export function buildPersonContextSuffix(options: {
  id: string;
  profile: string;
  /** `current.md` 全文（阶段 4）。整篇注入，上限已在写入时卡 1500 字。 */
  current?: string;
  previewPath?: string;
  selectedPreviewText?: string;
}): string {
  const profileBody = options.profile.length <= PROFILE_INLINE_LIMIT
    ? options.profile.trim()
    : `people/${options.id}/profile.md`;
  const lines = [
    "<系统提示>",
    `使用者是「我」。右侧「自己」是我，左侧是 id 为 ${options.id} 的人。称呼、昵称、简称见档案，身份以 id 为准。`,
    "档案正文：",
    profileBody,
  ];
  // 当前判断整篇注入：它回答「现在按什么判断来回复」，比档案更该先看到。
  // 没有正文时整段略过，不占窗口（空文件只有版本头，不能用 trim 判断）。
  const current = currentBody(options.current ?? "");
  if (current) {
    lines.push("当前判断（整篇，只回答现在按什么判断来回复）：", current);
  }
  lines.push(
    `历史简报路径：people/${options.id}/digest.md`,
    `原文路径：people/${options.id}/entries.jsonl`,
    "了解这个人先用档案和当前判断。了解一段对话经过什么，先分段读历史简报。历史简报是摘要，不是原话。",
  );
  if (current) lines.push("当前判断与历史简报不一致时，以当前判断为准。");
  lines.push(
    "只有用户明确要看原文或原话时，才分段读原文。",
    "要改历史简报时，修改 digest.md。要改原文中的一句时，只替换 entries.jsonl 里那一句的 text，不要改 id、at 和顺序。",
  );
  const previewPath = options.previewPath?.trim();
  const selected = options.selectedPreviewText?.trim();
  if (previewPath) lines.push("", `正在看：${previewPath}`);
  if (selected) lines.push("", "选中内容：", "```text", selected, "```");
  lines.push("</系统提示>");
  return lines.join("\n");
}

export function personIdFromThreadPath(threadPath: string | undefined): string | undefined {
  // 只认新路径 people/<id>；旧路径 inputs/people/<id> 一律 404（不做双读）。
  const match = /^people\/([A-Za-z0-9]+)\/?$/.exec((threadPath ?? "").trim());
  return match?.[1];
}
