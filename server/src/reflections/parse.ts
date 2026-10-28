/**
 * 记事本粘贴解析：标题行 +「中文/ISO 时间 + 情境」行 + 正文。
 * 多篇用空行分隔；每篇至少要有标题行，时间行可选。
 */

export type ParsedReflection = {
  title: string;
  occurredAt?: string;
  context?: string;
  body: string;
};

const CN_DATETIME =
  /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(.*)$/;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)(.*)$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 将时间行解析为 ISO（保留本地墙钟为 +08:00 偏移，无法判定时区时按东八）与情境尾。 */
export function parseOccurredLine(line: string): { occurredAt?: string; context?: string } {
  const trimmed = line.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return {};

  const cn = CN_DATETIME.exec(trimmed);
  if (cn) {
    const [, y, mo, d, h, mi, s, rest] = cn;
    const occurredAt = `${y}-${pad(Number(mo))}-${pad(Number(d))}T${pad(Number(h))}:${pad(Number(mi))}:${pad(Number(s || "0"))}+08:00`;
    const context = rest.replace(/^[\s，,、]+/, "").trim();
    return { occurredAt, ...(context ? { context } : {}) };
  }

  const iso = ISO_DATETIME.exec(trimmed);
  if (iso) {
    const head = iso[1].trim().replace(" ", "T");
    const candidate = head.length === 10 ? `${head}T00:00:00+08:00` : head;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      const context = iso[2].replace(/^[\s，,、]+/, "").trim();
      const occurredAt = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(candidate) ? candidate : date.toISOString();
      return { occurredAt, ...(context ? { context } : {}) };
    }
  }

  return { context: trimmed };
}

function isLikelyDatetimeLine(line: string): boolean {
  return CN_DATETIME.test(line.trim()) || /^\d{4}-\d{2}-\d{2}/.test(line.trim());
}

function parseOneBlock(block: string): ParsedReflection | null {
  const text = block.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const lines = text.split("\n");
  const title = (lines[0] || "").trim();
  if (!title) return null;

  let occurredAt: string | undefined;
  let context: string | undefined;
  let bodyStart = 1;

  if (lines.length > 1 && isLikelyDatetimeLine(lines[1])) {
    const parsed = parseOccurredLine(lines[1]);
    occurredAt = parsed.occurredAt;
    context = parsed.context;
    bodyStart = 2;
  }

  const body = lines.slice(bodyStart).join("\n").replace(/^\n+/, "").trimEnd();
  return {
    title,
    ...(occurredAt ? { occurredAt } : {}),
    ...(context ? { context } : {}),
    body,
  };
}

/** 拆成一篇或多篇。篇首判定：非空标题行 + 下一行是时间行，且位于文首或空行之后（正文中的空行不拆篇）。 */
export function parseReflectionPaste(raw: string): ParsedReflection[] {
  const normalized = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim()) continue;
    if (!isLikelyDatetimeLine(lines[i + 1])) continue;
    if (i === 0 || !lines[i - 1].trim()) starts.push(i);
  }

  if (starts.length === 0) {
    const title = (lines[0] || "未命名心得").trim() || "未命名心得";
    const rest = lines.slice(1).join("\n").trim();
    return [{ title, body: rest || normalized }];
  }

  const items: ParsedReflection[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const parsed = parseOneBlock(lines.slice(from, to).join("\n"));
    if (parsed) items.push(parsed);
  }
  return items;
}
