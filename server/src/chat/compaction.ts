import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger/index.js";
import type { Config } from "../config/index.js";
import { getProviderCredential, resolveModelThinking } from "../config/index.js";
import { getPaths } from "../config/paths.js";
import { createProvider } from "../llm/index.js";
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
}

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

  const summary = response.content?.trim();
  if (!summary) {
    throw new Error("Compaction failed: LLM returned empty summary");
  }

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
  return { archivedAs, usage };
}
