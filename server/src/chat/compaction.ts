import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger/index.js";
import type { Config } from "../config/index.js";
import { getProviderCredential, resolveModelThinking } from "../config/index.js";
import { getPaths } from "../config/paths.js";
import { createProvider } from "../llm/index.js";
import type { CompletionOptions, LLMProvider } from "../llm/index.js";
import { calcCost } from "../llm/cost.js";
import { loadSession, saveSession, generateId } from "../session/index.js";
import type { Message, MessageContentPart } from "../types/index.js";
import type { UsageRecord } from "../llm/types.js";

export const BUILTIN_COMPACTION_PROMPT = `你的任务是为本次对话创建一份详细摘要。这份摘要会被放在后续会话的开头，帮助模型在不读取完整历史的情况下继续工作。

请尽量完整保留上下文、重要结论、约束条件、待办项与未解决问题，并按以下结构输出：

## 对话背景
[理解本次讨论所需的前提信息、目标、限制条件]

## 讨论主题
[本次对话围绕的核心问题或主题]

## 主要观点与结论
- [重要结论 1]
- [重要结论 2]

## 关键概念与引用
- [概念 / 文件 / 术语，以及它在对话中的作用]

## 未解问题
- [仍待继续讨论的问题]`;

export interface CompactionResult {
  archivedAs: string;
  usage?: UsageRecord;
  /** 逐字保留的约束清单（plan §9 第一步的产出；提取失败时为空）。 */
  constraints: string[];
  /** 约束提取是否成功；false 表示已退回单步压缩。 */
  constraintsExtracted: boolean;
}

/**
 * 约束提取的提示词（plan §9 第一步）。
 *
 * 关键约束：**逐字抄写，不许改写、不许归纳、不许合并**。这样后续步骤把清单
 * 原样拼进摘要，模型下一轮读到的仍是用户原话，而不是被二次改写过的转述。
 */
export const CONSTRAINT_EXTRACTION_PROMPT = `你的任务是从下面的对话里提取"必须逐字保留的约束"，供压缩后的会话继续使用。

规则：
1. 只做抄写，不做改写、不做归纳、不做合并、不修正错别字。
2. 每条约束必须是从原文中**原样复制**的一句话或一个条件；不要添加原文没有的字。
3. 只收真正的约束：明确的禁止/必须/只能、具体的数值与格式要求、接口与字段名、路径、文件名、用户明确指定的偏好。
4. 不收：寒暄、临时讨论、尚未确认的猜测、你自己的总结。
5. 每条一行，行首用 "- "。没有约束就只输出 "无"。

对话：
<conversation>
{{CONVERSATION}}
</conversation>`;

/** 拼进摘要的标题，固定不变——下游靠它识别清单区间。 */
export const CONSTRAINT_SECTION_HEADER = "## 以下为逐字保留的约束（勿改写）";

async function loadCompactionPrompt(promptFile: string): Promise<string> {
  try {
    const content = await fs.readFile(promptFile, "utf-8");
    return content.trim() || BUILTIN_COMPACTION_PROMPT;
  } catch {
    return BUILTIN_COMPACTION_PROMPT;
  }
}

function serializeMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is Extract<MessageContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function serializeMessage(message: Message): string {
  const content = serializeMessageContent(message.content);
  const toolCalls = message.tool_calls?.length
    ? `\n工具调用: ${JSON.stringify(message.tool_calls)}`
    : "";
  const toolCallId = message.tool_call_id ? `\n工具调用结果 ID: ${message.tool_call_id}` : "";
  return `[${message.role}]\n${content}${toolCalls}${toolCallId}`;
}

function serializeConversation(messages: Message[]): string {
  return messages
    .filter((message) => {
      if (typeof message.content === "string") return true;
      return Boolean(serializeMessageContent(message.content));
    })
    .map(serializeMessage)
    .join("\n\n---\n\n");
}

function countRounds(messages: Message[]): number {
  let rounds = 0;
  for (const msg of messages) {
    if (msg.role === "user") rounds++;
  }
  return rounds;
}

function splitMessagesByRounds(
  messages: Message[],
  keepRounds: number,
): { toSummarize: Message[]; toKeep: Message[] } {
  if (keepRounds <= 0) return { toSummarize: messages, toKeep: [] };

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }

  if (userIndices.length <= keepRounds) {
    return { toSummarize: [], toKeep: messages };
  }

  const splitIndex = userIndices[userIndices.length - keepRounds];
  return {
    toSummarize: messages.slice(0, splitIndex),
    toKeep: messages.slice(splitIndex),
  };
}

function safeTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * 把模型的约束提取结果规整成清单。
 *
 * 只做「去壳」不做「改写」：去掉空行、代码围栏、「无」、以及模型偶尔加上的
 * 「以下为…」引导句；每一行都保持原样（这正是逐字保留的含义）。
 */
export function normalizeConstraints(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!line) continue;
    // 模型有时会把整段包在「以下是约束：」这类引导句里，丢掉它。
    if (/^(以下|下面).*(约束|清单)[:：]?$/.test(line)) continue;
    if (line === "无" || line === "（无）" || line === "(无)") return [];
    const item = line.replace(/^[-*•]\s*/, "").replace(/^\d+[.、]\s*/, "").trim();
    if (!item) continue;
    out.push(item);
  }
  if (inFence) {
    // 没闭合的围栏不影响结果，只是说明模型格式不规范。
  }
  return out;
}

/**
 * 第一步：独立调用一次，要求逐字抄写约束（plan §9）。
 *
 * 失败不阻塞压缩：记录日志、返回空清单，退回到原有的单步摘要行为。
 */
async function extractConstraints(
  provider: LLMProvider,
  apiKey: string,
  options: CompletionOptions,
  conversationText: string,
  logger: Logger,
): Promise<{ constraints: string[]; usage?: UsageRecord }> {
  try {
    const response = await provider.complete(apiKey, [
      {
        id: "system",
        role: "system",
        content: CONSTRAINT_EXTRACTION_PROMPT.replace("{{CONVERSATION}}", conversationText),
        timestamp: new Date().toISOString(),
      },
      {
        id: "user",
        role: "user",
        // 内容已在 system 里，这里只做触发，避免重复计费体积。
        content: "请按上述规则输出约束清单。",
        timestamp: new Date().toISOString(),
      },
    ], { ...options, maxTokens: 2048 });
    return { constraints: normalizeConstraints(response.content ?? ""), usage: response.usage as UsageRecord | undefined };
  } catch (error) {
    logger.warn(`Constraint extraction failed, falling back to single-step compaction: ${(error as Error).message}`);
    return { constraints: [] };
  }
}

/** 摘要 + 逐字约束清单（plan §9 第 3 步）。清单为空时不加小节。 */
export function mergeConstraintsIntoSummary(summary: string, constraints: string[]): string {
  if (constraints.length === 0) return summary;
  const list = constraints.map((item) => `- ${item}`).join("\n");
  return `${summary.trim()}\n\n${CONSTRAINT_SECTION_HEADER}\n\n${list}`;
}

export async function compactSession(
  sessionId: string,
  config: Config,
  logger: Logger,
  keepRecentRounds?: number,
): Promise<CompactionResult> {
  const paths = getPaths();
  const session = await loadSession(sessionId);

  if (session.messages.length < 2) {
    throw new Error("Session has fewer than 2 messages, compaction not needed");
  }

  const keep = keepRecentRounds ?? config.compaction.keepRecentRounds;
  const totalRounds = countRounds(session.messages);

  if (keep > 0 && totalRounds <= keep + 1) {
    throw new Error(
      `Compaction not needed: session has ${totalRounds} round(s), ` +
      `which is not more than keepRecentRounds (${keep}) + 1`,
    );
  }

  const { toSummarize, toKeep } = splitMessagesByRounds(session.messages, keep);

  if (toSummarize.length < 2) {
    throw new Error("Session has too few messages to summarize after keeping recent rounds");
  }

  const prompt = await loadCompactionPrompt(paths.compactionPromptFile);
  if (!config.compaction.provider) {
    throw new Error("Compaction provider is required");
  }
  const providerName = config.compaction.provider;
  const providerCredential = getProviderCredential(config, providerName);
  const provider = createProvider(providerName);
  const model = config.compaction.model;
  if (!model) {
    throw new Error("Compaction model is required");
  }
  const apiKey = providerCredential.apiKey;
  const baseUrl = providerCredential.baseUrl;
  const thinking = resolveModelThinking(config, providerName, model, config.compaction.thinkingEffort);
  const conversationText = serializeConversation(toSummarize);

  logger.info(`Compacting session ${sessionId}`, {
    messageCount: session.messages.length,
    summarizeCount: toSummarize.length,
    keepCount: toKeep.length,
    keepRecentRounds: keep,
    model,
  });

  // 第一步：逐字提取约束（独立调用）。失败不阻塞，退回到现有单步行为。
  const extraction = await extractConstraints(provider, apiKey, {
    model,
    baseUrl,
    maxTokens: 2048,
    thinkingEffort: thinking.level,
    thinkingParams: thinking.params,
  }, conversationText, logger);
  const constraints = extraction.constraints;
  const constraintsExtracted = constraints.length > 0;
  if (!constraintsExtracted) {
    logger.info(`No constraints extracted for session ${sessionId}; summarizing only.`);
  }

  const response = await provider.complete(apiKey, [
    {
      id: "system",
      role: "system",
      content: prompt,
      timestamp: new Date().toISOString(),
    },
    {
      id: "user",
      role: "user",
      content: `<conversation>\n${conversationText}\n</conversation>`,
      timestamp: new Date().toISOString(),
    },
  ], {
    model,
    baseUrl,
    maxTokens: 4096,
    thinkingEffort: thinking.level,
    thinkingParams: thinking.params,
  });

  const rawSummary = response.content?.trim();
  if (!rawSummary) {
    throw new Error("Compaction failed: LLM returned empty summary");
  }
  // 第三步：摘要 + 「以下为逐字保留的约束（勿改写）」+ 清单。
  const summary = mergeConstraintsIntoSummary(rawSummary, constraints);

  const sessionFile = path.join(paths.conversations, `${sessionId}.jsonl`);
  const archivedAs = `${sessionId}_${safeTimestampForFilename(new Date())}.jsonl`;
  const archiveFile = path.join(paths.conversationArchive, archivedAs);

  await fs.mkdir(paths.conversationArchive, { recursive: true });
  await fs.copyFile(sessionFile, archiveFile);

  const now = new Date().toISOString();
  const summaryMessages: Message[] = [
    {
      id: generateId(),
      role: "user",
      content: "请回顾之前的对话",
      timestamp: now,
    },
    {
      id: generateId(),
      role: "assistant",
      content: summary,
      timestamp: now,
    },
  ];

  await saveSession({
    ...session,
    updatedAt: now,
    messages: [...summaryMessages, ...toKeep],
  });

  logger.info(`Session ${sessionId} compacted`, { archivedAs });
  const usage: UsageRecord | undefined = response.usage
    ? {
        ...response.usage,
        model,
        provider: providerName,
        timestamp: new Date().toISOString(),
        sessionId,
        cost: calcCost(response.usage, config.providers[providerName]?.models.find((m) => m.id === model)?.cost, new Date()),
      }
    : undefined;
  return { archivedAs, usage, constraints, constraintsExtracted };
}
