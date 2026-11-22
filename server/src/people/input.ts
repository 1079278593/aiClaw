/**
 * 人物页这一轮用户输入的落盘与注入规则。
 *
 * 用户原话先整段进 entries.jsonl（不改写），再开始这一轮分析。
 * 送给模型的单条消息有上限：超限时只放前一段，并写明全文在哪条原文里，
 * 让模型需要时自己分段读。截断的只是注入，原文始终完整。
 */

import { appendEntry, type PersonEntry } from "./store.js";

export const PERSON_INPUT_INLINE_LIMIT = 8_000;

export function preparePersonInput(personId: string, entryId: string, content: string): string {
  const text = content ?? "";
  if (text.length <= PERSON_INPUT_INLINE_LIMIT) return text;
  const head = text.slice(0, PERSON_INPUT_INLINE_LIMIT);
  return [
    head,
    "",
    `（这条输入过长，上面只放了前 ${PERSON_INPUT_INLINE_LIMIT} 字。全文在 people/${personId}/entries.jsonl 的 [${entryId}]，需要时用 read 分段读。）`,
  ].join("\n");
}

/**
 * 发送即入库：先写原文，再拿「注入版」的正文去跑分析。
 * 会话写入或生成失败都不影响已经落盘的这条原文。
 */
export async function recordPersonInput(
  personId: string,
  content: string,
  userDataDir?: string,
): Promise<{ entry: PersonEntry; visibleContent: string }> {
  const saved = await appendEntry(personId, { kind: "note", text: content }, userDataDir);
  return { entry: saved.entry, visibleContent: preparePersonInput(personId, saved.entry.id, content) };
}
