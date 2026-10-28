const PROFILE_INLINE_LIMIT = 12_000;

export function buildPersonContextSuffix(options: {
  id: string;
  profile: string;
  previewPath?: string;
  selectedPreviewText?: string;
}): string {
  const profileBody = options.profile.length <= PROFILE_INLINE_LIMIT
    ? options.profile.trim()
    : `inputs/people/${options.id}/profile.md`;
  const lines = [
    "<系统提示>",
    `使用者是「我」。右侧「自己」是我，左侧是 id 为 ${options.id} 的人。称呼、昵称、简称见档案，身份以 id 为准。`,
    "档案正文：",
    profileBody,
    `历史简报路径：inputs/people/${options.id}/digest.md`,
    `原文路径：inputs/people/${options.id}/entries.jsonl`,
    "了解这个人先用档案。了解一段对话经过什么，先分段读历史简报。历史简报是摘要，不是原话。",
    "只有用户明确要看原文或原话时，才分段读原文。",
    "要改历史简报时，修改 digest.md。要改原文中的一句时，只替换 entries.jsonl 里那一句的 text，不要改 id、at 和顺序。",
  ];
  const previewPath = options.previewPath?.trim();
  const selected = options.selectedPreviewText?.trim();
  if (previewPath) lines.push("", `正在看：${previewPath}`);
  if (selected) lines.push("", "选中内容：", "```text", selected, "```");
  lines.push("</系统提示>");
  return lines.join("\n");
}

export function personIdFromThreadPath(threadPath: string | undefined): string | undefined {
  const match = /^inputs\/people\/([A-Za-z0-9]+)\/?$/.exec((threadPath ?? "").trim());
  return match?.[1];
}
