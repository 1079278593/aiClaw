import { appendDigest, recordOrganizeOutcome, replaceCurrent, writeProfileIfComplete, type PersonEntry } from "./store.js";
import { currentBody } from "./profile.js";

export const ARCHIVE_MARKER = "<<<档案>>>";

/** 自动整理用的第二段：整篇替换 `current.md`（plan_people_reply §4）。 */
export const CURRENT_MARKER = "<<<当前>>>";

export const ORGANIZE_USER_TEXT = "整理目前新增的内容。";

/**
 * 自动整理时模型偶尔会用它表示「没有可写的」。
 * 这类回复按「没有正文」处理后，简报、当前判断与 `organizedAt` 都不动。
 */
const NOTHING_TO_WRITE = new Set(["无", "（无）", "(无)", "没有", "（没有）"]);

const ORGANIZE_INSTRUCTIONS = `已有历史简报在下面。这次只附上次整理末尾之后的原文。每条带 speaker 或 kind：speaker=me 是用户自己，speaker=them 是对方，kind=note 是用户写下的自述。

根据下面这次的原文，写历史简报。
保留重要信息，表达中心意思。废话和没有实质内容的不收录。改变了经过的短句要留下。
只写原文里有的，不补充原文没有的内容。人名和数字用原文里的词。
标明属于自己或对方的，仍属于这一方。自述不要写成某一方说的话。
已有历史简报不要重写。这次只写新增的一段，接在后面。

若档案需要按这次原文修改，在简报正文之后以 <<<档案>>> 开头，给出完整档案。不需要改就不要写档案。
不要修改 entries.jsonl。`;

/** 自动整理的提示词首句。材料拼装与测试都靠它判断「走的是自动路径」。 */
export const AUTO_ORGANIZE_INSTRUCTIONS_MARKER = "这次做两件事";

/**
 * 自动路径的说明（阶段 4）。
 *
 * 与手动整理的区别只有两处，但都很关键：
 * 1. **不许写档案**——自动跑的时候没人看，档案被改错无从发现（plan §4「档案」）。
 * 2. 多一段**当前判断**，整篇替换而不是追加。
 */
export const AUTO_ORGANIZE_INSTRUCTIONS = `已有历史简报和当前判断在下面。这次只附上次整理末尾之后的原文。每条带 speaker 或 kind：speaker=me 是用户自己，speaker=them 是对方，kind=note 是用户写下的自述。

这次做两件事。

一、历史简报：只写新增的一段，接在已有简报后面。已有段落不要重写。
保留重要信息，表达中心意思。废话和没有实质内容的不收录。改变了经过的短句要留下。
只写原文里有的，不补充原文没有的内容。人名和数字用原文里的词。
标明属于自己或对方的，仍属于这一方。自述不要写成某一方说的话。

二、当前判断：整篇重写，不是追加。只回答「现在按什么判断来回复这个人」，几行即可，不要超过 1500 字。
写在简报正文之后，以 <<<当前>>> 开头。这次没有可更新的判断就不要写这一段。

这次原文没有实质内容（例如只是一句提问、寒暄、没有新信息）时，只输出「无」。
不要写档案，不要修改 entries.jsonl。`;

/** 截断流式输出：任一标记之后的内容都不进气泡。 */
function visibleBeforeAnyMarker(raw: string): string {
  const markers = ARCHIVE_MARKER.length <= CURRENT_MARKER.length
    ? [ARCHIVE_MARKER, CURRENT_MARKER]
    : [CURRENT_MARKER, ARCHIVE_MARKER];
  let cut = raw.length;
  for (const marker of markers) {
    const index = raw.indexOf(marker);
    if (index !== -1 && index < cut) cut = index;
  }
  // 标记可能被分片：把疑似标记开头的尾巴先扣住，避免露出「<<<档」。
  const visible = raw.slice(0, cut);
  let hold = 0;
  for (const marker of markers) {
    const max = Math.min(marker.length - 1, visible.length);
    for (let size = max; size > 0; size -= 1) {
      if (marker.startsWith(visible.slice(-size)) && size > hold) {
        hold = size;
        break;
      }
    }
  }
  return visible.slice(0, visible.length - hold);
}

/** 兼容旧调用点：`<<<档案>>>` 之前的内容。 */
export function visibleBeforeMarker(raw: string): string {
  return visibleBeforeAnyMarker(raw);
}

export function splitOrganizeReply(raw: string): { brief: string; profile: string | null } {
  const index = raw.indexOf(ARCHIVE_MARKER);
  if (index === -1) return { brief: raw.trim(), profile: null };
  const profile = raw.slice(index + ARCHIVE_MARKER.length).trim();
  return { brief: raw.slice(0, index).trim(), profile: profile || null };
}

/**
 * 自动整理的回复：简报段 + 可选的 `<<<当前>>>` 段。
 * 两段都可能为空；调用方据此决定是否跳过。
 */
export function splitAutoOrganizeReply(raw: string): { brief: string; current: string } {
  const index = raw.indexOf(CURRENT_MARKER);
  if (index === -1) return { brief: raw.trim(), current: "" };
  return {
    brief: raw.slice(0, index).trim(),
    current: raw.slice(index + CURRENT_MARKER.length).trim(),
  };
}

export function renderEntries(entries: PersonEntry[]): string {
  if (entries.length === 0) return "（没有新的原文）";
  return entries.map((entry) => {
    const who = entry.kind === "note" ? "kind=note" : `speaker=${entry.speaker}`;
    return `[${entry.id}] ${who}\n${entry.text}`;
  }).join("\n\n");
}

/**
 * 手动整理（人点「整理」按钮）。档案替换只在这条路径上发生。
 *
 * 成功时把结局写进 `lastOrganize`，与自动整理的记录同一处，界面只管读一个字段。
 * 失败由调用方（`chat-handler`）记 `failed`，因为那里才知道要给用户报什么错。
 */
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
  await recordOrganizeOutcome(id, { at: new Date().toISOString(), status: "ok" }, userDataDir);
  return { brief };
}

export type AutoOrganizeOutcome = {
  /** 简报是否追加成功。false 表示这次整体跳过，`organizedAt` 未动。 */
  applied: boolean;
  /** 当前判断是否整篇替换成功；超 1500 字或为空时为 false。 */
  currentWritten: boolean;
  /** 当前判断正文字数，便于日志与测试核对上限。 */
  currentLength: number;
  /** 跳过原因。`applied` 为 true 时没有这个字段。 */
  skipped?: "no-fresh-entries" | "empty-brief" | "current-too-long";
};

const SKIP_MESSAGES: Record<NonNullable<AutoOrganizeOutcome["skipped"]>, string> = {
  "no-fresh-entries": "没有新的原文",
  "empty-brief": "这次没有需要写进简报的内容",
  "current-too-long": "当前判断超过 1500 字，保留了旧版本",
};

/**
 * 自动整理（阶段 4）。与手动路径的三点差别：
 *
 * 1. 没有正文时**跳过**，不抛错、不推进 `organizedAt`（下一轮会再读到这批原文）。
 * 2. **不写 `profile.md`**。回复里就算带了 `<<<档案>>>` 也丢掉，档案只由人触发。
 * 3. 同时整篇替换 `current.md`；超过 1500 字只跳过它，简报照常追加。
 *
 * 结局写进 `meta.json` 的 `lastOrganize`，界面据此显示「整理于 / 上次跳过原因」。
 */
export async function applyAutoOrganizeResult(
  id: string,
  rawReply: string,
  lastAt: string | undefined,
  userDataDir?: string,
): Promise<AutoOrganizeOutcome> {
  const split = splitAutoOrganizeReply(rawReply);
  const brief = split.brief.trim();
  if (!lastAt || !brief || NOTHING_TO_WRITE.has(brief)) {
    await recordOrganizeOutcome(
      id,
      { at: new Date().toISOString(), status: "skipped", message: SKIP_MESSAGES["empty-brief"] },
      userDataDir,
    );
    return { applied: false, currentWritten: false, currentLength: 0, skipped: "empty-brief" };
  }
  // 自动回复里若混进了档案段，只保留它前面的简报，避免把档案写进去。
  const safeBrief = splitOrganizeReply(brief).brief || brief;
  await appendDigest(id, safeBrief, lastAt, userDataDir);
  const replaced = await replaceCurrent(id, split.current, userDataDir);
  await recordOrganizeOutcome(
    id,
    {
      at: new Date().toISOString(),
      status: "ok",
      ...(replaced.written || !split.current.trim()
        ? {}
        : { message: SKIP_MESSAGES["current-too-long"] }),
    },
    userDataDir,
  );
  return {
    applied: true,
    currentWritten: replaced.written,
    currentLength: replaced.length,
    ...(replaced.written || !split.current.trim() ? {} : { skipped: "current-too-long" as const }),
  };
}

export function buildOrganizeMaterials(
  digest: string,
  profile: string,
  entries: PersonEntry[],
  current?: string,
): string {
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

/**
 * 自动整理的材料。比手动版少了「现有档案」：自动路径本来就不许改档案，
 * 把档案贴进去只会诱导模型写 `<<<档案>>>`，还白烧 token。
 */
export function buildAutoOrganizeMaterials(
  digest: string,
  current: string,
  entries: PersonEntry[],
): string {
  return [
    AUTO_ORGANIZE_INSTRUCTIONS,
    "",
    "已有历史简报：",
    digest.trim() || "（空）",
    "",
    "现有当前判断：",
    currentBody(current) || "（空）",
    "",
    "这次的原文：",
    renderEntries(entries),
  ].join("\n");
}
