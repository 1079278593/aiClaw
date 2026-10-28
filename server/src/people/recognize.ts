export type RecognizedLine = { speaker: "me" | "them"; text: string };

export const RECOGNIZE_PROMPT = `这是一张个人聊天截图。只识别双方说过的话，按画面从上到下排列。
靠右的气泡 speaker 为 me，靠左的气泡 speaker 为 them。
时间、系统灰字、「撤回了一条消息」不要输出。
左侧出现两个及以上不同的人，或画面是群聊时，只返回 {"error":"group"}。
没有双方说过的话时，只返回 {"error":"empty"}。
否则只返回 {"lines":[{"speaker":"me","text":"原话"}]}。不要补充画面里没有的话。`;

export function parseRecognition(raw: string): { lines: RecognizedLine[] } | { error: "group" | "fail" } {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: "fail" };
  }
  if (!parsed || typeof parsed !== "object") return { error: "fail" };
  const record = parsed as { error?: unknown; lines?: unknown };
  if (record.error === "group") return { error: "group" };
  if (record.error === "empty" || !Array.isArray(record.lines) || record.lines.length === 0) return { error: "fail" };
  const lines: RecognizedLine[] = [];
  for (const item of record.lines) {
    if (!item || typeof item !== "object") return { error: "fail" };
    const line = item as { speaker?: unknown; text?: unknown };
    if ((line.speaker !== "me" && line.speaker !== "them") || typeof line.text !== "string" || !line.text.trim()) {
      return { error: "fail" };
    }
    lines.push({ speaker: line.speaker, text: line.text });
  }
  return { lines };
}
