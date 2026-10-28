export const PROFILE_HEADINGS = ["## 基本信息", "## 个人资料", "## 近况", "## 和我之间", "## 我的判断", "## 待核"] as const;

export const BASIC_ITEMS = ["称呼", "昵称", "简称", "关系", "如何认识", "身份或工作", "所在"] as const;

export const EMPTY_PROFILE = `---
schemaVersion: 1
---

## 基本信息
- 称呼：
- 昵称：
- 简称：
- 关系：
- 如何认识：
- 身份或工作：
- 所在：

## 个人资料

无

## 近况

无

## 和我之间

无

## 我的判断

无

## 待核

无
`;

export const EMPTY_DIGEST = `---
schemaVersion: 1
---
`;

export function profileHeadingsComplete(markdown: string): boolean {
  if (!PROFILE_HEADINGS.every((heading) => markdown.includes(heading))) return false;
  return BASIC_ITEMS.every((item) => new RegExp(`^- ${item}：`, "m").test(markdown));
}

export function profileField(markdown: string, name: string): string {
  const match = markdown.match(new RegExp(`^- ${escapeRegExp(name)}：\\s*(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function splitNameList(value: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of value.split("、")) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function namesFromProfile(markdown: string): { name: string; nicknames: string[]; shortNames: string[] } {
  return {
    name: profileField(markdown, "称呼"),
    nicknames: splitNameList(profileField(markdown, "昵称")),
    shortNames: splitNameList(profileField(markdown, "简称")),
  };
}

export function profileWithName(markdown: string, name: string): string {
  return markdown.replace(/^(- 称呼：)\s*$/m, `$1${name}`);
}

export function replaceUneditedName(markdown: string, oldName: string, newName: string): string {
  const pattern = new RegExp(`^(- 称呼：)\\s*${escapeRegExp(oldName)}\\s*$`, "m");
  if (!pattern.test(markdown)) return markdown;
  return markdown.replace(pattern, `$1${newName}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
