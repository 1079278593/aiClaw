/**
 * 心得会话的对话状态（context_governance_plan §2.2）。
 *
 * 为什么不在会话文件里：会话可以被删除，而「已经确立的结论与约束」不该跟着消失。
 * 所以状态按会话 id 存在 `agents/main/dialogue-state.md`，删会话不删文件；
 * 新建一条会话 id 不同的心得会话时，也不会继承上一条的状态。
 *
 * 文件形状（每个会话一块，互不干扰）：
 *
 * ```markdown
 * <!-- dialogue-state：... -->
 *
 * ## 会话 5f2c...
 *
 * <!-- foldedThrough: <messageId> -->
 * <!-- updatedAt: 2026-11-19T00:00:00.000Z -->
 *
 * ### 当前有效
 *
 * ## 硬约束
 *
 * 正文……
 *
 * ### 沿革
 *
 * #### 2026-11-18T00:00:00.000Z
 *
 * 旧正文……
 * ```
 *
 * 会话标题必须带 `会话 ` 前缀：状态正文本身就是 Markdown，里面会有 `## 硬约束`
 * 这类二级标题。只用 `## ` 当分隔符会把正文切成「另一个会话」。
 * 只注入「当前有效」，沿革只留档。这样注入体积是一块，不随折叠次数增长。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { getPaths } from "../config/paths.js";
import { estimateTokens } from "./context-budget.js";

/** 「当前有效」的注入上限：超了整块不注入，不截成半块。 */
export const DIALOGUE_STATE_TOKEN_MAX = 2000;

export type DialogueHistoryBlock = {
  /** 进入沿革的时刻（ISO-8601）。 */
  at: string;
  text: string;
};

export type DialogueSessionState = {
  /** 已经收进状态的最后一条消息 id；没有表示还没收过。 */
  foldedThrough?: string;
  /** 当前生效的那一块，注入用。 */
  current: string;
  /** 旧块归档，不注入。 */
  history: DialogueHistoryBlock[];
  updatedAt?: string;
};

const FILE_HEADER = "<!-- dialogue-state：心得会话的对话状态。每块按会话 id 分开，foldedThrough 之前的原文已收进「当前有效」。 -->";
const SESSION_HEADING = "## 会话 ";
const CURRENT_HEADING = "### 当前有效";
const HISTORY_HEADING = "### 沿革";
const HISTORY_ITEM_PREFIX = "#### "; 

function stateFile(userDataDir?: string): string {
  return getPaths(userDataDir).dialogueStateFile;
}

function parseMeta(line: string): { key: string; value: string } | null {
  const match = /^<!--\s*([A-Za-z]+):\s*(.*?)\s*-->$/.exec(line.trim());
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

/** 解析整个文件。坏块跳过，不给别的会话添麻烦。 */
export function parseDialogueStates(raw: string): Map<string, DialogueSessionState> {
  const states = new Map<string, DialogueSessionState>();
  const lines = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").split("\n");
  let sessionId: string | null = null;
  let state: DialogueSessionState | null = null;
  let section: "none" | "current" | "history" = "none";
  let buffer: string[] = [];
  let historyBlock: DialogueHistoryBlock | null = null;

  const flushText = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!state) return;
    if (section === "current") state.current = text === "无" ? "" : text;
    else if (section === "history" && historyBlock) {
      historyBlock.text = text;
      if (historyBlock.text) state.history.push(historyBlock);
      historyBlock = null;
    }
  };

  for (const line of lines) {
    // 会话分隔必须带前缀：状态正文里会有 `## 硬约束` 这种二级标题。
    if (line.startsWith(SESSION_HEADING)) {
      flushText();
      if (sessionId && state) states.set(sessionId, state);
      sessionId = line.slice(SESSION_HEADING.length).trim();
      state = { current: "", history: [] };
      section = "none";
      continue;
    }
    if (!state) continue;

    const meta = parseMeta(line);
    if (meta) {
      if (meta.key === "foldedThrough") state.foldedThrough = meta.value || undefined;
      if (meta.key === "updatedAt") state.updatedAt = meta.value || undefined;
      continue;
    }
    if (line.trim() === CURRENT_HEADING) {
      flushText();
      section = "current";
      continue;
    }
    if (line.trim() === HISTORY_HEADING) {
      flushText();
      section = "history";
      continue;
    }
    if (section === "history" && line.startsWith(HISTORY_ITEM_PREFIX)) {
      flushText();
      historyBlock = { at: line.slice(HISTORY_ITEM_PREFIX.length).trim(), text: "" };
      continue;
    }
    if (section === "none") continue;
    buffer.push(line);
  }
  flushText();
  if (sessionId && state) states.set(sessionId, state);
  return states;
}

/** 渲染回文件。顺序按传入的 Map 顺序，不排序——保持写入顺序稳定。 */
export function renderDialogueStates(states: Map<string, DialogueSessionState>): string {
  const parts: string[] = [FILE_HEADER];
  for (const [sessionId, state] of states) {
    // 正文里的 `## 硬约束` 是内容，不是分隔符：会话标题带固定前缀才能分开。
    const block: string[] = [`${SESSION_HEADING}${sessionId}`];
    if (state.foldedThrough) block.push("", `<!-- foldedThrough: ${state.foldedThrough} -->`);
    if (state.updatedAt) block.push(`<!-- updatedAt: ${state.updatedAt} -->`);
    // 空状态写「无」占位；解析时再退化回空串，避免把占位符注入模型。
    block.push("", CURRENT_HEADING, "", state.current.trim() || "无");
    if (state.history.length > 0) {
      block.push("", HISTORY_HEADING);
      for (const item of state.history) {
        block.push("", `${HISTORY_ITEM_PREFIX}${item.at}`, "", item.text.trim());
      }
    }
    parts.push("", block.join("\n"));
  }
  return `${parts.join("\n")}\n`;
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** 原子写：临时名唯一，避免并发写抢同一个文件。 */
async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 按文件串行化读-改-写：折叠与手动压缩可能同时发生。 */
const queues = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(file, next.catch(() => undefined));
  return next;
}

export async function loadAllDialogueStates(userDataDir?: string): Promise<Map<string, DialogueSessionState>> {
  return parseDialogueStates(await readText(stateFile(userDataDir)));
}

/** 取单个会话的状态；没有就返回空块（不是错误）。 */
export async function loadDialogueState(
  sessionId: string,
  userDataDir?: string,
): Promise<DialogueSessionState> {
  const states = await loadAllDialogueStates(userDataDir);
  return states.get(sessionId) ?? { current: "", history: [] };
}

/** 覆盖单个会话的状态，其它会话原样保留。 */
export async function saveDialogueState(
  sessionId: string,
  state: DialogueSessionState,
  userDataDir?: string,
): Promise<void> {
  const file = stateFile(userDataDir);
  await withLock(file, async () => {
    const states = parseDialogueStates(await readText(file));
    states.set(sessionId, state);
    await writeAtomic(file, renderDialogueStates(states));
  });
}

/**
 * 删掉某个会话的状态块，其它会话不动。
 *
 * 与「删会话不删文件」的关系：心得会话删了要保留状态（那是人的长期结论），
 * 人物分析会话删了要连块一起删（那条状态只属于这一次分析，留着会与新会话
 * 的判断混在一起）。调用方按 `session.fold` + 身份决定是否调用这里。
 */
export async function removeDialogueState(sessionId: string, userDataDir?: string): Promise<boolean> {
  const file = stateFile(userDataDir);
  return withLock(file, async () => {
    const states = parseDialogueStates(await readText(file));
    if (!states.delete(sessionId)) return false;
    await writeAtomic(file, renderDialogueStates(states));
    return true;
  });
}

/**
 * 只把游标丢掉，保留「当前有效」。
 *
 * 用于会话被截断、游标指向的消息已经不存在的情况：结论仍然有效，
 * 但不能让游标悬空——否则 `pendingRange` 会一直返回 null，这条会话
 * 再也不会折叠，而窗口又会退回发送全部原文。
 */
export async function resetDialogueCursor(sessionId: string, userDataDir?: string): Promise<boolean> {
  const file = stateFile(userDataDir);
  return withLock(file, async () => {
    const states = parseDialogueStates(await readText(file));
    const state = states.get(sessionId);
    if (!state || !state.foldedThrough) return false;
    states.set(sessionId, { current: state.current, history: state.history, updatedAt: new Date().toISOString() });
    await writeAtomic(file, renderDialogueStates(states));
    return true;
  });
}

/**
 * 注入用的「当前有效」一块。
 *
 * 超过 `DIALOGUE_STATE_TOKEN_MAX` 时整块不注入并返回原因——半块状态比没有更误导。
 */
export async function loadCurrentDialogueBlock(
  sessionId: string,
  userDataDir?: string,
): Promise<{ text: string; skipped?: "empty" | "too-large"; tokens: number }> {
  const state = await loadDialogueState(sessionId, userDataDir);
  const current = state.current.trim();
  if (!current) return { text: "", skipped: "empty", tokens: 0 };
  const tokens = estimateTokens(current);
  if (tokens > DIALOGUE_STATE_TOKEN_MAX) return { text: "", skipped: "too-large", tokens };
  return { text: current, tokens };
}
