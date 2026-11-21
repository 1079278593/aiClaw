/**
 * 心得会话的状态折叠（context_governance_plan §2）。
 *
 * 与 `compactSession` 的根本区别：这里**不重写历史**。会话 jsonl 保持原样，
 * 只在 `dialogue-state.md` 里按批追加「当前有效」，并把游标往前挪。
 * 因此不会出现「上一版摘要被再摘要一次」的漂移。
 *
 * 三条硬规则：
 * 1. 游标之后的原文始终留在窗口里，直到这一批被成功收进状态；
 * 2. 8000 token 只决定要不要调用模型，不决定窗口里放什么；
 * 3. 失败（空输出、超 2000 token）不挪游标、不换「当前有效」，只记日志。
 */

import type { Logger } from "../logger/index.js";
import type { Config } from "../config/index.js";
import type { ProviderName } from "../config/index.js";
import { getProviderCredential, resolveModelThinking } from "../config/index.js";
import { createProvider } from "../llm/index.js";
import type { CompletionOptions, LLMProvider } from "../llm/index.js";
import { calcCost } from "../llm/cost.js";
import type { UsageRecord } from "../llm/types.js";
import { loadSession, saveSession } from "../session/index.js";
import type { Message } from "../types/index.js";
import { estimateTokens, extractTextContent, groupByTurn, messageTokens } from "./context-budget.js";
import {
  DIALOGUE_STATE_TOKEN_MAX,
  loadDialogueState,
  saveDialogueState,
  type DialogueSessionState,
} from "./dialogue-state.js";

/** 触发折叠的待处理体积。达到才调用模型，不到就把原文继续留在窗口里。 */
export const FOLD_TRIGGER_TOKENS = 8000;

/** 保护区：最近 2 轮（按用户消息计）永远保持原文，不进状态。 */
export const FOLD_KEEP_ROUNDS = 2;

/** 折叠输出留给模型的预算。 */
const FOLD_MAX_OUTPUT_TOKENS = 4096;

/**
 * 折叠提示词。
 *
 * 与压缩提示词的分工：压缩是「写给下一轮的摘要」，这里是「按语义角色收成状态」。
 * 因此结构固定、没有的写「无」、硬约束逐字抄，不追求覆盖全部细节。
 */
export const FOLD_SYSTEM_PROMPT = `你的任务是把一段已经发生的对话，按语义角色收进一份「当前有效」的状态。这份状态会替代原文进入后续请求，原文不再重复发送。

输出必须使用下面的固定小节，没有内容的写「无」，不要省略小节，不要写前言或结语：

## 硬约束
原样保留：用户明确要求的禁止/必须/只能、具体数值与格式、接口与字段名、路径与文件名、明确的偏好。
这些内容必须逐字抄写，不得改写、归纳或合并。本批没有推翻的，从旧状态原样搬过来。

## 已定结论
已经做出的决定以及理由。被否决的方案只留「方案 + 为什么不要」，不保留讨论过程。

## 未决问题
还没定的事、卡在哪里、等谁/等什么。

## 重要事实
后续要用到的事实性信息：人名、项目名、关键数据、外部约定。寒暄、确认性回复、已被推翻的中间结论一律不收。

规则：
1. 只依据下面的旧状态与本批对话，不要补充你自己的推断。
2. 硬约束一律逐字，其余收成结论，不保留对话口吻。
3. 已被本批明确推翻的旧结论要删掉，不要同时留下两种说法。
4. 输出总长控制在 2000 token 以内；实在放不下，优先保住硬约束与未决问题。`;

export type FoldResult = {
  /** 本次结果。 */
  outcome:
    | "no-session"
    | "no-pending"
    | "below-threshold"
    | "cursor-missing"
    | "folded"
    | "partial"
    | "failed";
  /** 成功收进状态的批次数量。 */
  batches: number;
  /** 本次推进后的游标。 */
  foldedThrough?: string;
  /** 处理了多少条消息。 */
  processedMessages: number;
  /** 折叠产出的新「当前有效」的 token 数（失败时为 0）。 */
  stateTokens: number;
  /** 失败原因，仅用于日志与接口回显。 */
  reason?: string;
  usage: UsageRecord[];
};

function serializeMessage(message: Message): string {
  const text = extractTextContent(message.content).trim();
  const calls = message.tool_calls?.length
    ? `\n（工具调用：${message.tool_calls.map((call) => call.function.name).join("、")}）`
    : "";
  return `[${message.role}] ${text}${calls}`.trim();
}

/** 保护区起点：最后 `keepRounds` 个用户消息中最早的那条的下标。 */
export function protectedTailStart(messages: Message[], keepRounds: number): number {
  if (keepRounds <= 0) return messages.length;
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length <= keepRounds) return 0;
  return userIndices[userIndices.length - keepRounds];
}

/** 待处理区间：游标之后、保护区之前。游标不存在时返回 null（交给调用方决定）。 */
export function pendingRange(
  messages: Message[],
  foldedThrough: string | undefined,
  keepRounds: number,
): { start: number; end: number } | null {
  if (foldedThrough === undefined) return { start: 0, end: protectedTailStart(messages, keepRounds) };
  const cursor = messages.findIndex((message) => message.id === foldedThrough);
  if (cursor < 0) return null;
  const end = protectedTailStart(messages, keepRounds);
  if (end <= cursor + 1) return { start: cursor + 1, end: cursor + 1 };
  return { start: cursor + 1, end };
}

/** 把待处理消息按轮切成放得下的段。每段是一个完整的 turn 序列。 */
export function segmentTurns(messages: Message[], maxTokens: number): Message[][] {
  const turns = groupByTurn(messages);
  const segments: Message[][] = [];
  let current: Message[] = [];
  let tokens = 0;
  for (const turn of turns) {
    const turnTokens = turn.reduce((sum, message) => sum + messageTokens(message), 0);
    if (current.length > 0 && tokens + turnTokens > maxTokens) {
      segments.push(current);
      current = [];
      tokens = 0;
    }
    current.push(...turn);
    tokens += turnTokens;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function buildModelOptions(config: Config, providerName: ProviderName, model: string): {
  options: CompletionOptions;
  apiKey: string;
  model: string;
  maxInputTokens: number;
} {
  const credential = getProviderCredential(config, providerName);
  const thinking = resolveModelThinking(config, providerName, model, config.compaction.thinkingEffort);
  const modelConfig = config.providers[providerName]?.models?.find((item) => item.id === model);
  const window = Math.min(
    modelConfig?.contextWindow ?? config.contextMaxTokens,
    config.contextMaxTokens,
  );
  return {
    apiKey: credential.apiKey,
    model,
    maxInputTokens: Math.max(2000, window - FOLD_MAX_OUTPUT_TOKENS),
    options: {
      model,
      baseUrl: credential.baseUrl,
      maxTokens: FOLD_MAX_OUTPUT_TOKENS,
      thinkingEffort: thinking.level,
      thinkingParams: thinking.params,
    },
  };
}

async function callFoldModel(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  previous: string,
  conversation: string,
): Promise<{ text: string; usage?: UsageRecord }> {
  const response = await provider.complete(apiKey, [
    {
      id: "system",
      role: "system",
      content: FOLD_SYSTEM_PROMPT,
      timestamp: new Date().toISOString(),
    },
    {
      id: "user",
      role: "user",
      content: [
        "<旧状态>",
        previous.trim() || "无",
        "</旧状态>",
        "",
        "<本批对话>",
        conversation,
        "</本批对话>",
      ].join("\n"),
      timestamp: new Date().toISOString(),
    },
  ], options);
  return { text: response.content?.trim() ?? "", usage: response.usage as UsageRecord | undefined };
}

/**
 * 折叠一次。
 *
 * `force` 用于手动压缩：不看 8000 token，有待处理原文就处理。
 * `provider` 只给测试注入假模型用；生产路径一律按 `config.compaction` 建。
 */
export async function foldDialogueState(
  sessionId: string,
  config: Config,
  logger: Logger,
  options: { force?: boolean; provider?: LLMProvider } = {},
): Promise<FoldResult> {
  const empty: FoldResult = { outcome: "no-session", batches: 0, processedMessages: 0, stateTokens: 0, usage: [] };

  let session;
  try {
    session = await loadSession(sessionId);
  } catch {
    return empty;
  }

  const state: DialogueSessionState = await loadDialogueState(sessionId);
  const range = pendingRange(session.messages, state.foldedThrough, FOLD_KEEP_ROUNDS);
  if (range === null) {
    logger.warn("dialogue fold skipped: cursor message not found", { sessionId, foldedThrough: state.foldedThrough });
    return {
      ...empty,
      outcome: "cursor-missing",
      foldedThrough: state.foldedThrough,
      reason: "游标指向的消息已不存在",
    };
  }

  const pending = session.messages.slice(range.start, range.end);
  if (pending.length === 0) {
    return { ...empty, outcome: "no-pending", foldedThrough: state.foldedThrough };
  }

  const pendingTokens = pending.reduce((sum, message) => sum + messageTokens(message), 0);
  if (!options.force && pendingTokens < FOLD_TRIGGER_TOKENS) {
    return {
      ...empty,
      outcome: "below-threshold",
      foldedThrough: state.foldedThrough,
      processedMessages: pending.length,
    };
  }

  if (!config.compaction.provider || !config.compaction.model) {
    logger.warn("dialogue fold skipped: compaction provider/model not configured", { sessionId });
    return { ...empty, outcome: "failed", reason: "未配置压缩模型", foldedThrough: state.foldedThrough };
  }

  const built = buildModelOptions(config, config.compaction.provider, config.compaction.model);
  // 本地固定一次：跨 await 后 TS 不再保留上面的窄化，直接读 config 会变成 string | undefined。
  const providerName: ProviderName = config.compaction.provider;
  const provider = options.provider ?? createProvider(providerName);
  // 用假模型时没有真实凭证，跳过 key 检查（只影响测试注入路径）。
  if (!options.provider && !built.apiKey) {
    return { ...empty, outcome: "failed", reason: "压缩模型没有可用凭证", foldedThrough: state.foldedThrough };
  }
  const segments = segmentTurns(pending, Math.max(2000, built.maxInputTokens - estimateTokens(state.current)));
  const usage: UsageRecord[] = [];

  let current = state.current;
  let foldedThrough = state.foldedThrough;
  let processed = 0;
  let batches = 0;
  let failure: string | undefined;

  for (const segment of segments) {
    const conversation = segment.map(serializeMessage).join("\n\n---\n\n");
    let result: { text: string; usage?: UsageRecord };
    try {
      result = await callFoldModel(provider, built.apiKey, built.options, current, conversation);
    } catch (error) {
      failure = `模型调用失败：${(error as Error).message}`;
      logger.warn(`dialogue fold batch failed: ${failure}`, { sessionId });
      break;
    }

    const next = result.text.trim();
    if (!next) {
      failure = "模型返回空状态";
      logger.warn(`dialogue fold batch failed: ${failure}`, { sessionId });
      break;
    }
    if (estimateTokens(next) > DIALOGUE_STATE_TOKEN_MAX) {
      failure = `新状态超过 ${DIALOGUE_STATE_TOKEN_MAX} token`;
      logger.warn(`dialogue fold batch failed: ${failure}`, { sessionId });
      break;
    }

    const at = new Date().toISOString();
    const nextState: DialogueSessionState = {
      foldedThrough: segment[segment.length - 1].id,
      current: next,
      history: current.trim()
        ? [...state.history, { at, text: current }]
        : state.history,
      updatedAt: at,
    };
    await saveDialogueState(sessionId, nextState);
    current = next;
    foldedThrough = segment[segment.length - 1].id;
    processed += segment.length;
    batches += 1;
    if (result.usage) {
      usage.push({
        ...result.usage,
        model: built.model,
        provider: providerName,
        timestamp: at,
        sessionId,
        cost: calcCost(
          result.usage,
          config.providers[providerName]?.models?.find((item) => item.id === built.model)?.cost,
          new Date(at),
        ),
      });
    }
  }

  if (batches === 0) {
    return {
      outcome: "failed",
      batches: 0,
      foldedThrough: state.foldedThrough,
      processedMessages: 0,
      stateTokens: 0,
      reason: failure,
      usage,
    };
  }

  await trimStubbedToolResults(sessionId, foldedThrough, logger).catch((error) => {
    logger.warn(`tool stub after fold failed: ${(error as Error).message}`);
  });

  return {
    outcome: failure ? "partial" : "folded",
    batches,
    foldedThrough,
    processedMessages: processed,
    stateTokens: estimateTokens(current),
    ...(failure ? { reason: failure } : {}),
    usage,
  };
}

/** 机械缩短阈值：超过这个字节数的工具结果在折叠之后改写成记录。 */
export const TOOL_STUB_BYTES = 4 * 1024;

function stubToolContent(original: string, name: string, target: string): string {
  const bytes = Buffer.byteLength(original, "utf-8");
  const head = `[工具结果已归档] 工具：${name || "未知"}${target ? ` · 目标：${target}` : ""} · 原文 ${bytes} 字节`;
  const truncated = /截断|truncated/i.test(original) ? " · 原文曾标注截断" : "";
  return `${head}${truncated}\n（该轮已收进对话状态，原文不再逐字保留。）`;
}

/** 从 assistant 的 tool_calls 里取参数，用于记录「读了哪个路径/查了什么」。 */
function toolTarget(message: Message | undefined): string {
  const raw = message?.tool_calls?.[0]?.function?.arguments;
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed.path ?? parsed.query ?? parsed.urls ?? parsed.url ?? parsed.name;
    if (typeof value === "string") return value.slice(0, 200);
    if (Array.isArray(value)) return value.map((item) => String(item)).join(",").slice(0, 200);
  } catch {
    return raw.slice(0, 120);
  }
  return "";
}

/**
 * 折叠之后缩短历史里的大工具结果（§3）。
 *
 * 只改游标覆盖范围内、超过 4KB 的 `tool` 消息：它们的内容已经进入状态，
 * 再逐字保留只是重复占窗口。游标之后的工具结果保持全文——那可能正是
 * 当轮推理要用的。
 */
export async function trimStubbedToolResults(
  sessionId: string,
  foldedThrough: string | undefined,
  logger: Logger,
): Promise<number> {
  if (!foldedThrough) return 0;
  const session = await loadSession(sessionId);
  const cursor = session.messages.findIndex((message) => message.id === foldedThrough);
  if (cursor < 0) return 0;

  const callsById = new Map<string, Message>();
  for (const message of session.messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) callsById.set(call.id, message);
  }

  let changed = 0;
  for (let i = 0; i <= cursor; i += 1) {
    const message = session.messages[i];
    if (message.role !== "tool") continue;
    const text = extractTextContent(message.content);
    if (!text || Buffer.byteLength(text, "utf-8") <= TOOL_STUB_BYTES) continue;
    if (text.startsWith("[工具结果已归档]")) continue;
    const owner = message.tool_call_id ? callsById.get(message.tool_call_id) : undefined;
    const name = owner?.tool_calls?.find((call) => call.id === message.tool_call_id)?.function.name ?? "";
    message.content = stubToolContent(text, name, toolTarget(owner));
    changed += 1;
  }

  if (changed > 0) {
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    logger.info(`stubbed ${changed} large tool result(s)`, { sessionId });
  }
  return changed;
}

/** 只有游标之后的原文才进窗口：把已折叠的消息从历史里摘掉（保留保护区）。 */
export function historyAfterCursor(messages: Message[], foldedThrough: string | undefined): Message[] {
  if (!foldedThrough) return messages;
  const cursor = messages.findIndex((message) => message.id === foldedThrough);
  if (cursor < 0) return messages;
  return messages.slice(cursor + 1);
}
