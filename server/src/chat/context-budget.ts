/**
 * 上下文预算装配。
 *
 * 把窗口视为**需要预先分配的预算**，而不是「先塞满再截断」：
 * 1. 先锚定本轮用户消息（无条件进入结果）；
 * 2. 系统/策略块独立上限，超出时按可变性从低到高丢；
 * 3. 历史按剩余额度**以 turn 为单位**从新到旧装填，整组进或整组丢；
 * 4. 装完断言：本轮用户消息在结果中，且没有孤立的 tool 消息。
 *
 * 固定内容（策略 + 本轮用户消息）本身超窗时**明确失败**，绝不静默截断用户消息。
 */

import type { Message, MessageContentPart } from "../types/index.js";

// ---- token 估算 ----

/**
 * 旧的 `len / 3` 对中文低估约 3 倍，会让预算严重超装。
 * `cjk * 0.7 + ascii / 3.5 + lines` 是零依赖的经验式，比引入分词器更实用。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x2e7f) cjk += 1;
    else ascii += 1;
  }
  const lines = text.includes("\n") ? text.split("\n").length : 0;
  return Math.ceil(cjk * 0.7 + ascii / 3.5 + lines);
}

export function extractTextContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Extract<MessageContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function messageTokens(message: Message): number {
  const text = extractTextContent(message.content);
  let total = estimateTokens(text);
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      // 图片单列为「附件（估算）」：不参与主条百分比，但仍要占预算。
      total += IMAGE_TOKEN_ESTIMATE;
    }
  }
  if (message.tool_calls?.length) total += estimateTokens(JSON.stringify(message.tool_calls));
  return total;
}

/** 一张图按固定估算计入预算，避免按 base64 长度算出荒谬数值。 */
export const IMAGE_TOKEN_ESTIMATE = 800;

// ---- 校准因子：内存、按 provider/model 分桶、不落盘 ----

const CALIBRATION_MIN = 0.5;
const CALIBRATION_MAX = 2.0;
const calibrationFactors = new Map<string, number>();

export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function getCalibrationFactor(provider: string, model: string): number {
  return calibrationFactors.get(modelKey(provider, model)) ?? 1.0;
}

/** 用 provider 返回的真实 `prompt_tokens` 滚动校准。返回值已 clamp。 */
export function updateCalibration(
  provider: string,
  model: string,
  actualPromptTokens: number,
  estimatedTokens: number,
): number {
  if (!Number.isFinite(actualPromptTokens) || !Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
    return getCalibrationFactor(provider, model);
  }
  const raw = actualPromptTokens / estimatedTokens;
  const clamped = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, raw));
  calibrationFactors.set(modelKey(provider, model), clamped);
  return clamped;
}

/** 测试用：清空校准记忆。 */
export function resetCalibration(): void {
  calibrationFactors.clear();
}

// ---- 预算装配 ----

/** 系统块：按「可变性」从高到低排列，淘汰时先丢索引尾。 */
export type SystemBlockName = "rootIndex" | "runtime" | "focus" | "user" | "distillMap" | "policy";

export type SystemBlock = {
  name: SystemBlockName;
  text: string;
  /** 该块的 token 上限。 */
  max: number;
  enabled?: boolean;
};

export type BudgetBlockReport = {
  name: SystemBlockName | "history" | "userTurn" | "attachment";
  tokens: number;
  max?: number;
  enabled?: boolean;
  droppedTurns?: number;
  anchored?: boolean;
};

export type ContextBudgetReport = {
  window: number;
  reserve: number;
  available: number;
  blocks: BudgetBlockReport[];
  total: number;
  ratio: number;
  calibration: number;
};

export type AssembleInput = {
  /** 本轮用户消息（llm 侧内容，可能含图片）。 */
  userMessage: Message;
  /** 历史消息（不含 system 与本轮 user）。 */
  history: Message[];
  systemBlocks?: SystemBlock[];
  /** 实际可用 = min(contextMaxTokens, modelContextWindow) - maxTokens。 */
  contextMaxTokens: number;
  modelContextWindow?: number;
  maxTokens: number;
  calibrationFactor?: number;
  /** 附加注入（例如当前打开文件的预览），有上限。 */
  injections?: Array<{ name: string; text: string; max: number }>;
};

export type AssembleResult = {
  messages: Message[];
  report: ContextBudgetReport;
};

export class ContextBudgetError extends Error {
  constructor(
    message: string,
    readonly detail: { systemTokens: number; userTokens: number; window: number; available: number },
  ) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

/**
 * 装配顺序固定：锚定用户消息 → 系统块 → 注入 → 历史（turn 粒度，从新到旧）。
 *
 * 纯函数：不读文件、不写盘、不改入参。
 */
export function assembleContextBudget(input: AssembleInput): AssembleResult {
  const factor = clampFactor(input.calibrationFactor ?? 1);
  const window = Math.min(input.contextMaxTokens, input.modelContextWindow ?? Number.POSITIVE_INFINITY);
  const reserve = input.maxTokens;
  const available = Math.max(0, window - reserve);
  const scale = (text: string) => Math.ceil(estimateTokens(text) * factor);

  // 1. 结构化锚定本轮用户消息：不参与淘汰，也不允许被挤掉。
  const userTokens = Math.ceil(messageTokens(input.userMessage) * factor);
  const userMessage: Message = input.userMessage;

  // 2. 系统块：各自独立上限，超出时按可变性丢（rootIndex → runtime → focus → user → policy）。
  const blocks = (input.systemBlocks ?? []).filter((block) => block.enabled !== false);
  const blockReports: BudgetBlockReport[] = [];
  const keptSystem: string[] = [];
  let systemTokens = 0;
  for (const block of blocks) {
    const tokens = scale(block.text);
    const within = tokens <= block.max;
    const text = within ? block.text : "";
    const used = within ? tokens : 0;
    keptSystem.push(text);
    systemTokens += used;
    blockReports.push({ name: block.name, tokens: used, max: block.max, enabled: block.enabled !== false });
  }

  // 3. 注入块：同样有上限，超限直接放弃（不截断成半张地图）。
  const injectionReports: BudgetBlockReport[] = [];
  const keptInjections: string[] = [];
  for (const injection of input.injections ?? []) {
    const tokens = scale(injection.text);
    if (tokens <= injection.max) {
      keptInjections.push(injection.text);
      injectionReports.push({ name: "attachment", tokens, max: injection.max });
      systemTokens += tokens;
    } else {
      injectionReports.push({ name: "attachment", tokens: 0, max: injection.max });
    }
  }

  // 固定内容（系统 + 用户消息）本身超窗 → 明确失败，不静默截断。
  const fixed = systemTokens + userTokens;
  if (fixed > available) {
    throw new ContextBudgetError("本轮内容超出上下文", {
      systemTokens,
      userTokens,
      window,
      available,
    });
  }

  // 4. 历史：turn 粒度，从新到旧，整组进或整组丢；装不下就继续尝试更早的组。
  const turns = groupByTurn(input.history);
  const keptTurns: Message[][] = [];
  let historyTokens = 0;
  let droppedTurns = 0;
  let budgetLeft = available - fixed;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const tokens = turn.reduce((sum, message) => sum + Math.ceil(messageTokens(message) * factor), 0);
    if (tokens > budgetLeft) {
      droppedTurns += 1;
      continue;
    }
    keptTurns.unshift(turn);
    historyTokens += tokens;
    budgetLeft -= tokens;
  }

  const systemMessages: Message[] = [];
  const systemText = [...keptSystem, ...keptInjections].filter(Boolean).join("\n\n");
  if (systemText.trim()) {
    systemMessages.push({
      id: "system",
      role: "system",
      content: systemText,
      timestamp: input.userMessage.timestamp,
    });
  }

  const messages: Message[] = [
    ...systemMessages,
    ...keptTurns.flat(),
    userMessage,
  ];

  assertAssembled(messages, userMessage);

  const total = systemTokens + userTokens + historyTokens;
  const report: ContextBudgetReport = {
    window,
    reserve,
    available,
    blocks: [
      ...blockReports,
      ...injectionReports,
      { name: "history", tokens: historyTokens, droppedTurns },
      { name: "userTurn", tokens: userTokens, anchored: true },
    ],
    total,
    ratio: available > 0 ? Number((total / available).toFixed(3)) : 0,
    calibration: factor,
  };

  return { messages, report };
}

function clampFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, value));
}

/**
 * 以 turn 为单位分组：assistant 的 tool_calls 与随后的 tool 结果属于同一组。
 * 按单条跳过会产生孤儿 tool 消息，provider 直接报错。
 */
export function groupByTurn(history: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const message of history) {
    if (message.role === "user") {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    current.push(message);
    // 没有未完成 tool_calls 的 assistant 文本视作该 turn 的收尾。
    if (message.role === "assistant" && !message.tool_calls?.length) {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/** 断言：用户消息必在，且没有孤立的 tool 消息。失败直接抛，不静默继续。 */
export function assertAssembled(messages: Message[], userMessage: Message): void {
  const hasUser = messages.some((message) =>
    message === userMessage
    || (message.role === "user" && message.id === userMessage.id));
  if (!hasUser) {
    throw new ContextBudgetError("装配结果缺少本轮用户消息", {
      systemTokens: 0,
      userTokens: 0,
      window: 0,
      available: 0,
    });
  }

  const knownCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) knownCallIds.add(call.id);
      continue;
    }
    if (message.role !== "tool") continue;
    // tool 消息必须能找到它对应的 assistant tool_call（同一条消息内或更早）。
    if (!message.tool_call_id || !knownCallIds.has(message.tool_call_id)) {
      throw new ContextBudgetError("装配结果存在孤立的 tool 消息", {
        systemTokens: 0,
        userTokens: 0,
        window: 0,
        available: 0,
      });
    }
  }
}
