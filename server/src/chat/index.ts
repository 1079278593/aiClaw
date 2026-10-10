/**
 * Chat Core - Message handling and LLM coordination
 *
 * Manages chat sessions, context window, and coordinates with LLM provider.
 * Implements agentic loop with non-streaming complete() calls.
 * Final reply is pseudo-streamed from the last complete() result.
 */

import fs from "node:fs/promises";
import type { Message, MessageContentPart, Session } from "../types/index.js";
import { logger } from "../logger/index.js";
import { loadSession, addMessage, generateId, saveSession } from "../session/index.js";
import { createProvider } from "../llm/index.js";
import type { CompletionOptions, CompletionResponse, StreamFinish } from "../llm/index.js";
import type { Config, ProviderName } from "../config/index.js";
import { getProviderCredential, resolveModelThinking } from "../config/index.js";
import { getPaths } from "../config/paths.js";
import { recordRecentModel } from "../app-state/index.js";
import { getTools } from "../tools/registry.js";
import { executeTool } from "../tools/executor.js";
import type { ToolDefinition } from "../tools/types.js";
import type { NormalizedUsage, UsageRecord } from "../llm/types.js";
import { calcCost } from "../llm/cost.js";

export interface ChatOptions {
  stream?: boolean;
  maxTokens?: number;
  thinkingEffort?: string;
  provider?: ProviderName;
  model?: string;
  persistedUserContent?: string | MessageContentPart[];
  userMessageId?: string;
  onReasoningChunk?: (chunk: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>, callId: string) => void;
  onToolResult?: (name: string, content: string, isError: boolean, callId: string) => void;
  checkPermission?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  signal?: AbortSignal;
}

interface ChatRunSettings {
  providerName: ProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
  thinkingEffort?: string;
  thinkingParams: Record<string, unknown>;
}

export interface ChatResult {
  sessionId: string;
  userMessage: Message;
  assistantMessage: Message;
  usage?: UsageRecord;
  contextUsage?: UsageRecord;
}

function mergeUsage(current: NormalizedUsage | null, incoming?: NormalizedUsage | null): NormalizedUsage | null {
  if (!incoming) return current;
  const thinkingTokens = (current?.thinkingTokens ?? 0) + (incoming.thinkingTokens ?? 0);
  const cachedReadTokens = (current?.cachedReadTokens ?? 0) + (incoming.cachedReadTokens ?? 0);
  const cachedWriteTokens = (current?.cachedWriteTokens ?? 0) + (incoming.cachedWriteTokens ?? 0);

  return {
    inputTokens: (current?.inputTokens ?? 0) + incoming.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + incoming.outputTokens,
    billingOutputTokens: (current?.billingOutputTokens ?? 0) + incoming.billingOutputTokens,
    thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined,
    cachedReadTokens: cachedReadTokens > 0 ? cachedReadTokens : undefined,
    cachedWriteTokens: cachedWriteTokens > 0 ? cachedWriteTokens : undefined,
  };
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

function extractTextContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Extract<MessageContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function stripImageParts(message: Message): Message | null {
  if (!Array.isArray(message.content)) return message;
  const textParts = message.content.filter((part): part is Extract<MessageContentPart, { type: "text" }> => part.type === "text");
  if (!textParts.length) return null;
  return { ...message, content: textParts };
}

export function sanitizeHistoryForProvider(
  messages: Message[],
  supportsImages: boolean = true,
): Message[] {
  // 所有 provider 都保留历史 reasoning_content（供多轮上下文参考）；
  // 仅图片需要按模型能力剥离。
  if (supportsImages) return messages;
  return messages
    .map(stripImageParts)
    .filter((message): message is Message => Boolean(message));
}

function formatToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

async function loadSystemPrompt(config: Config): Promise<string | null> {
  void config;
  const resolved = getPaths().agentSystemPromptFile;
  let content: string | null = null;
  try {
    content = (await fs.readFile(resolved, "utf-8")).trim() || null;
  } catch {
    logger.debug(`System prompt file not found: ${resolved}`);
  }
  // 实时附加当前日期，让 agent 知道"今天"
  const dateLine = `今天的日期是${formatToday()}`;
  return content ? `${content}\n\n${dateLine}` : dateLine;
}

function resolveChatRunSettings(config: Config, options: ChatOptions): ChatRunSettings {
  const providerName = options.provider ?? config.defaultProvider;
  const fallbackModel = config.providers[providerName]?.models?.[0]?.id ?? config.defaultModel;
  const model = options.model ?? (providerName === config.defaultProvider ? config.defaultModel : fallbackModel);
  const credential = getProviderCredential(config, providerName);
  const thinking = resolveModelThinking(config, providerName, model, options.thinkingEffort);

  return {
    providerName,
    model,
    apiKey: credential.apiKey,
    baseUrl: credential.baseUrl,
    thinkingEffort: thinking.level,
    thinkingParams: thinking.params,
  };
}

async function persistSessionRuntimeMeta(sessionId: string, providerName: ProviderName, model: string, thinkingEffort?: string) {
  const session = await loadSession(sessionId);
  session.lastProvider = providerName;
  session.lastModel = model;
  session.lastThinkingEffort = thinkingEffort;
  session.updatedAt = new Date().toISOString();
  await saveSession(session);
  // 与实际使用同步：每次 LLM 请求结束后记录最近使用的模型，失败不影响主流程
  try {
    await recordRecentModel(providerName, model);
  } catch (error) {
    logger.warn(`Failed to record recent model: ${(error as Error).message}`);
  }
}

function buildUsageRecord(
  usage: NormalizedUsage | null,
  providerName: ProviderName,
  model: string,
  sessionId: string,
  costConfig?: import("../config/schema.js").CostConfig,
): UsageRecord | undefined {
  if (!usage) return undefined;

  const timestamp = new Date();
  return {
    ...usage,
    model,
    provider: providerName,
    timestamp: timestamp.toISOString(),
    sessionId,
    cost: calcCost(usage, costConfig, timestamp),
  };
}


export function truncateMessagesForContext(
  messages: Message[],
  maxTokens: number = 100_000,
  maxMessages: number = 0,
): Message[] {
  const systemMessages = messages.filter((m) => m.role === "system");
  let conversationMessages = messages.filter((m) => m.role !== "system");

  if (maxMessages > 0 && conversationMessages.length > maxMessages) {
    conversationMessages = conversationMessages.slice(-maxMessages);
  }

  let currentTokens = systemMessages.reduce((sum, m) => sum + estimateTokens(extractTextContent(m.content)), 0);

  const keptConversation: Message[] = [];
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i];
    const tokens = estimateTokens(extractTextContent(msg.content));
    if (currentTokens + tokens > maxTokens) break;
    keptConversation.unshift(msg);
    currentTokens += tokens;
  }

  const result = [...systemMessages, ...keptConversation];

  if (result.length === 0 && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    const content = extractTextContent(lastMsg.content);
    const contentTokens = estimateTokens(content);
    if (contentTokens > maxTokens) {
      result.push({ ...lastMsg, content: content.slice(0, maxTokens * 3) });
    } else {
      result.push(lastMsg);
    }
  }

  logger.debug(`Truncated context: ${messages.length} -> ${result.length} messages`);
  return result;
}

function toLLMTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

type LoopEvent =
  | { type: "reasoning"; text: string }
  | { type: "textChunk"; text: string }
  | { type: "toolCall"; name: string; input: Record<string, unknown>; callId: string }
  | { type: "toolResult"; name: string; content: string; isError: boolean; callId: string };

interface AgenticLoopResult {
  extraMessages: Message[];
  finalText: string | null;
  finalReasoning?: string | null;
  accumulatedUsage: NormalizedUsage | null;
  contextUsage: NormalizedUsage | null;
  denied?: boolean;
  cancelled?: boolean;
  maxToolCallsReached?: boolean;
}

function resolveFinalAssistantContent(finalText: string | null, maxToolCallsReached: boolean): string {
  if (finalText?.trim()) return finalText;
  return maxToolCallsReached ? "（已达到最大工具调用次数）" : "（模型未返回可见文本）";
}

/** Ensure every assistant(tool_calls) in extraMessages has matching tool results.
 *  If cancelled mid-round, the last assistant may have tool_calls without results. */
function fixUnmatchedToolCalls(msgs: Message[]): void {
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant" || !last.tool_calls?.length) return;
  const matchedIds = new Set<string>();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg.role === "tool" && msg.tool_call_id) matchedIds.add(msg.tool_call_id);
    if (msg === last) break;
  }
  for (const tc of last.tool_calls) {
    if (!matchedIds.has(tc.id)) {
      msgs.push({
        id: generateId(),
        role: "tool",
        content: "已取消",
        timestamp: new Date().toISOString(),
        tool_call_id: tc.id,
      });
    }
  }
}

async function* runAgenticLoop(
  provider: ReturnType<typeof createProvider>,
  apiKey: string,
  messages: Message[],
  tools: ToolDefinition[],
  sessionId: string,
  sessionTitle: string,
  maxToolCalls: number,
  llmOptions: CompletionOptions,
  supportsImages: boolean,
  checkPermission?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>,
  signal?: AbortSignal,
): AsyncGenerator<LoopEvent, AgenticLoopResult, unknown> {
  const extraMessages: Message[] = [];
  let toolCallCount = 0;
  const llmTools = toLLMTools(tools);
  let accumulatedUsage: NormalizedUsage | null = null;
  let contextUsage: NormalizedUsage | null = null;
  let reasoningBuffer: string | null = null;

  while (toolCallCount < maxToolCalls) {
    reasoningBuffer = null;
    if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };

    const allMessages = [...messages, ...extraMessages];
    const opts: CompletionOptions = { ...llmOptions, tools: llmTools };
    if (signal) opts.signal = signal;

    let response: CompletionResponse;
    try {
      response = await provider.complete(apiKey, allMessages, opts);
    } catch (err) {
      if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };
      throw err;
    }
    accumulatedUsage = mergeUsage(accumulatedUsage, response.usage);
    contextUsage = response.usage ?? contextUsage;

    if (response.reasoning_content) {
      reasoningBuffer = response.reasoning_content;
      yield { type: "reasoning", text: response.reasoning_content };
    }

    if (response.finish_reason === "tool_calls" && response.tool_calls && response.tool_calls.length > 0) {
      extraMessages.push({
        id: generateId(),
        role: "assistant",
        content: response.content,
        timestamp: new Date().toISOString(),
        tool_calls: response.tool_calls,
        ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}),
      });

      // Phase 1: parse inputs and check limit
      const remaining = maxToolCalls - toolCallCount;
      const calls = response.tool_calls.slice(0, remaining);
      toolCallCount += calls.length;

      const parsedCalls = calls.map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // leave input as {}
        }
        return { id: tc.id, name: tc.function.name, input };
      });

      // Phase 2: yield all toolCall events upfront
      for (const call of parsedCalls) {
        yield { type: "toolCall", name: call.name, input: call.input, callId: call.id };
      }

      // Phase 3: check permissions serially (frontend only shows one dialog at a time)
      if (checkPermission) {
        for (const call of parsedCalls) {
          if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };
          const allowed = await checkPermission(call.name, call.input);
          if (!allowed) {
            extraMessages.push({
              id: generateId(),
              role: "tool",
              content: "用户拒绝了此操作",
              timestamp: new Date().toISOString(),
              tool_call_id: call.id,
            });
            yield { type: "toolResult", name: call.name, content: "用户拒绝了此操作", isError: true, callId: call.id };
            return { extraMessages, finalText: null, accumulatedUsage, contextUsage, denied: true };
          }
        }
      }

      // Phase 4: execute all tools in parallel
      const results = await Promise.all(
        parsedCalls.map((call) =>
          executeTool(call.name, call.input, tools, { sessionId, sessionTitle, supportsImages }),
        ),
      );
      if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };

      // Phase 5: yield results and build messages
      for (let i = 0; i < parsedCalls.length; i++) {
        const call = parsedCalls[i];
        const result = results[i];

        yield { type: "toolResult", name: call.name, content: result.content, isError: result.isError ?? false, callId: call.id };

        const toolContent: Message["content"] = result.imageParts?.length
          ? [{ type: "text", text: result.content }, ...result.imageParts]
          : result.content;

        extraMessages.push({
          id: generateId(),
          role: "tool",
          content: toolContent,
          timestamp: new Date().toISOString(),
          tool_call_id: call.id,
        });
      }
    } else {
      return { extraMessages, finalText: response.content, finalReasoning: reasoningBuffer, accumulatedUsage, contextUsage };
    }
  }

  logger.warn(`Max tool calls (${maxToolCalls}) reached`);
  return { extraMessages, finalText: null, accumulatedUsage, contextUsage, maxToolCallsReached: true };
}

async function* runAgenticLoopStreaming(
  provider: ReturnType<typeof createProvider>,
  apiKey: string,
  messages: Message[],
  tools: ToolDefinition[],
  sessionId: string,
  sessionTitle: string,
  maxToolCalls: number,
  llmOptions: CompletionOptions,
  supportsImages: boolean,
  checkPermission?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>,
  signal?: AbortSignal,
): AsyncGenerator<LoopEvent, AgenticLoopResult, unknown> {
  const extraMessages: Message[] = [];
  let toolCallCount = 0;
  const llmTools = toLLMTools(tools);
  let accumulatedUsage: NormalizedUsage | null = null;
  let contextUsage: NormalizedUsage | null = null;
  let reasoningBuffer: string | null = null;

  while (toolCallCount < maxToolCalls) {
    reasoningBuffer = null;
    if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };

    const allMessages = [...messages, ...extraMessages];

    // Speculative streaming: forward content chunks to the frontend until a
    // tool_call delta appears, at which point we switch to buffering mode.
    let contentBuffer = "";
    let hasToolCalls = false;

    const streamOpts: CompletionOptions = { ...llmOptions, tools: llmTools };
    if (signal) streamOpts.signal = signal;
    const streamGen = provider.stream(apiKey, allMessages, streamOpts);

    let finish: StreamFinish;
    try {
      let streamResult = await streamGen.next();
      while (!streamResult.done) {
        if (signal?.aborted) return { extraMessages, finalText: contentBuffer || null, accumulatedUsage, contextUsage, cancelled: true };
        const chunk = streamResult.value;
        if (chunk.type === "reasoning") {
          reasoningBuffer = (reasoningBuffer || "") + chunk.text;
          yield { type: "reasoning", text: chunk.text };
        } else if (chunk.type === "content") {
          contentBuffer += chunk.text;
          if (!hasToolCalls) {
            yield { type: "textChunk", text: chunk.text };
          }
        } else if (chunk.type === "toolCallDelta") {
          hasToolCalls = true;
        } else if (chunk.type === "usage") {
          accumulatedUsage = mergeUsage(accumulatedUsage, chunk.usage);
          contextUsage = chunk.usage ?? contextUsage;
        }
        streamResult = await streamGen.next();
      }
      finish = streamResult.value;
    } catch (err) {
      if (signal?.aborted) return { extraMessages, finalText: contentBuffer || null, accumulatedUsage, contextUsage, cancelled: true };
      throw err;
    }

    if (finish.finish_reason === "tool_calls" && finish.tool_calls && finish.tool_calls.length > 0) {
      extraMessages.push({
        id: generateId(),
        role: "assistant",
        content: contentBuffer || null,
        timestamp: new Date().toISOString(),
        tool_calls: finish.tool_calls,
        ...(reasoningBuffer ? { reasoning_content: reasoningBuffer } : {}),
      });

      // Phase 1: parse inputs and check limit
      const remaining = maxToolCalls - toolCallCount;
      const calls = finish.tool_calls.slice(0, remaining);
      toolCallCount += calls.length;

      const parsedCalls = calls.map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // leave input as {}
        }
        return { id: tc.id, name: tc.function.name, input };
      });

      // Phase 2: yield all toolCall events upfront
      for (const call of parsedCalls) {
        yield { type: "toolCall", name: call.name, input: call.input, callId: call.id };
      }

      // Phase 3: check permissions serially
      if (checkPermission) {
        for (const call of parsedCalls) {
          if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };
          const allowed = await checkPermission(call.name, call.input);
          if (!allowed) {
            extraMessages.push({
              id: generateId(),
              role: "tool",
              content: "用户拒绝了此操作",
              timestamp: new Date().toISOString(),
              tool_call_id: call.id,
            });
            yield { type: "toolResult", name: call.name, content: "用户拒绝了此操作", isError: true, callId: call.id };
            return { extraMessages, finalText: null, accumulatedUsage, contextUsage, denied: true };
          }
        }
      }

      // Phase 4: execute all tools in parallel
      const results = await Promise.all(
        parsedCalls.map((call) =>
          executeTool(call.name, call.input, tools, { sessionId, sessionTitle, supportsImages }),
        ),
      );
      if (signal?.aborted) return { extraMessages, finalText: null, accumulatedUsage, contextUsage, cancelled: true };

      // Phase 5: yield results and build messages
      for (let i = 0; i < parsedCalls.length; i++) {
        const call = parsedCalls[i];
        const result = results[i];

        yield { type: "toolResult", name: call.name, content: result.content, isError: result.isError ?? false, callId: call.id };

        const toolContent: Message["content"] = result.imageParts?.length
          ? [{ type: "text", text: result.content }, ...result.imageParts]
          : result.content;

        extraMessages.push({
          id: generateId(),
          role: "tool",
          content: toolContent,
          timestamp: new Date().toISOString(),
          tool_call_id: call.id,
        });
      }
    } else {
      return { extraMessages, finalText: contentBuffer || null, finalReasoning: reasoningBuffer, accumulatedUsage, contextUsage };
    }
  }

  logger.warn(`Max tool calls (${maxToolCalls}) reached`);
  return { extraMessages, finalText: null, accumulatedUsage, contextUsage, maxToolCallsReached: true };
}

export async function chat(
  sessionId: string,
  userContent: string | MessageContentPart[],
  config: Config,
  options: ChatOptions = {},
): Promise<ChatResult> {
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const persistedUserContent = options.persistedUserContent ?? userContent;
  const session = await loadSession(sessionId);
  const userMessage: Message = {
    id: options.userMessageId ?? generateId(),
    role: "user",
    content: persistedUserContent,
    timestamp: new Date().toISOString(),
  };
  const llmUserMessage: Message = {
    ...userMessage,
    content: userContent,
  };
  const run = resolveChatRunSettings(config, options);
  const supportsImages = config.providers[run.providerName]?.models?.find((item) => item.id === run.model)?.modal === "vl";
  const historyForProvider = sanitizeHistoryForProvider(session.messages, supportsImages);

  const systemPromptContent = await loadSystemPrompt(config);
  const systemMessages: Message[] = systemPromptContent
    ? [{ id: "system", role: "system", content: systemPromptContent, timestamp: new Date().toISOString() }]
    : [];
  const messagesForContext = truncateMessagesForContext(
    [...systemMessages, ...historyForProvider, llmUserMessage],
    config.contextMaxTokens,
    config.contextMaxMessages,
  );

  logger.debug("Sending chat to LLM", { sessionId, messageCount: messagesForContext.length });
  const provider = createProvider(run.providerName);
  const tools = getTools();
  const llmOptions: CompletionOptions = {
    model: run.model,
    baseUrl: run.baseUrl,
    maxTokens,
      thinkingEffort: run.thinkingEffort,
      thinkingParams: run.thinkingParams,
  };

  const extraMessages: Message[] = [];
  let finalText: string | null = null;
  let finalReasoning: string | null | undefined = null;
  let accumulatedUsage: NormalizedUsage | null = null;
  let contextUsage: NormalizedUsage | null = null;
  let maxToolCallsReached = false;
  const loopGen = runAgenticLoop(provider, run.apiKey, messagesForContext, tools, sessionId, session.title, config.maxToolCalls, llmOptions, supportsImages, options.checkPermission, options.signal);

  while (true) {
    const { value, done } = await loopGen.next();
    if (done) {
      extraMessages.push(...value.extraMessages);
      finalText = value.finalText;
      finalReasoning = value.finalReasoning;
      accumulatedUsage = value.accumulatedUsage;
      contextUsage = value.contextUsage;
      maxToolCallsReached = value.maxToolCallsReached ?? false;
      if (value.cancelled) {
        // Persist partial messages, mark the assistant reply as cancelled
        fixUnmatchedToolCalls(extraMessages);
        for (const message of extraMessages) await addMessage(sessionId, message);
        const cancelledMsg: Message = { id: generateId(), role: "assistant", content: finalText ? `${finalText}\n\n*(已取消)*` : "*(已取消)*", timestamp: new Date().toISOString() };
        await addMessage(sessionId, cancelledMsg);
        await persistSessionRuntimeMeta(sessionId, run.providerName, run.model, run.thinkingEffort);
        return { sessionId, userMessage, assistantMessage: cancelledMsg, usage: undefined, contextUsage: undefined };
      }
      if (value.denied) {
        await addMessage(sessionId, userMessage);
        for (const message of extraMessages) await addMessage(sessionId, message);
        await persistSessionRuntimeMeta(sessionId, run.providerName, run.model, run.thinkingEffort);
        const dummyAssistant: Message = { id: generateId(), role: "assistant", content: "", timestamp: new Date().toISOString() };
        return { sessionId, userMessage, assistantMessage: dummyAssistant, usage: undefined, contextUsage: undefined };
      }
      break;
    }

    if (value.type === "toolCall") options.onToolCall?.(value.name, value.input, value.callId);
    else if (value.type === "toolResult") options.onToolResult?.(value.name, value.content, value.isError, value.callId);
    else if (value.type === "reasoning") options.onReasoningChunk?.(value.text);
  }

  const assistantMessage: Message = {
    id: generateId(),
    role: "assistant",
    content: resolveFinalAssistantContent(finalText, maxToolCallsReached),
    timestamp: new Date().toISOString(),
    ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
  };

  await addMessage(sessionId, userMessage);
  for (const message of extraMessages) await addMessage(sessionId, message);
  await addMessage(sessionId, assistantMessage);
  await persistSessionRuntimeMeta(sessionId, run.providerName, run.model, run.thinkingEffort);

  const usage = buildUsageRecord(accumulatedUsage, run.providerName, run.model, sessionId,
    config.providers[run.providerName]?.models.find((m) => m.id === run.model)?.cost);
  const contextUsageRecord = buildUsageRecord(contextUsage, run.providerName, run.model, sessionId,
    config.providers[run.providerName]?.models.find((m) => m.id === run.model)?.cost);

  logger.info("Chat completed", { sessionId });
  return { sessionId, userMessage, assistantMessage, usage, contextUsage: contextUsageRecord };
}

export async function* chatStream(
  sessionId: string,
  userContent: string | MessageContentPart[],
  config: Config,
  options: ChatOptions = {},
): AsyncGenerator<{ chunk: string; done: boolean; reasoning?: boolean; cancelled?: boolean; usage?: UsageRecord; contextUsage?: UsageRecord }, ChatResult, unknown> {
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const persistedUserContent = options.persistedUserContent ?? userContent;
  const session = await loadSession(sessionId);
  const userMessage: Message = {
    id: options.userMessageId ?? generateId(),
    role: "user",
    content: persistedUserContent,
    timestamp: new Date().toISOString(),
  };
  const llmUserMessage: Message = {
    ...userMessage,
    content: userContent,
  };
  const run = resolveChatRunSettings(config, options);
  const supportsImages = config.providers[run.providerName]?.models?.find((item) => item.id === run.model)?.modal === "vl";
  const historyForProvider = sanitizeHistoryForProvider(session.messages, supportsImages);

  const systemPromptContent = await loadSystemPrompt(config);
  const systemMessages: Message[] = systemPromptContent
    ? [{ id: "system", role: "system", content: systemPromptContent, timestamp: new Date().toISOString() }]
    : [];
  const messagesForContext = truncateMessagesForContext(
    [...systemMessages, ...historyForProvider, llmUserMessage],
    config.contextMaxTokens,
    config.contextMaxMessages,
  );

  logger.debug("Sending streaming chat to LLM", { sessionId, messageCount: messagesForContext.length });
  await addMessage(sessionId, userMessage);
  const provider = createProvider(run.providerName);
  const tools = getTools();
  const llmOptions: CompletionOptions = {
    model: run.model,
    baseUrl: run.baseUrl,
    maxTokens,
    thinkingEffort: run.thinkingEffort,
    thinkingParams: run.thinkingParams,
  };

  const extraMessages: Message[] = [];
  let finalText: string | null = null;
  let finalReasoning: string | null | undefined = null;
  let accumulatedUsage: NormalizedUsage | null = null;
  let contextUsage: NormalizedUsage | null = null;
  let maxToolCallsReached = false;
  let hasStreamedText = false;
  const loopGen = runAgenticLoopStreaming(provider, run.apiKey, messagesForContext, tools, sessionId, session.title, config.maxToolCalls, llmOptions, supportsImages, options.checkPermission, options.signal);

  while (true) {
    const { value, done } = await loopGen.next();
    if (done) {
      extraMessages.push(...value.extraMessages);
      finalText = value.finalText;
      finalReasoning = value.finalReasoning;
      accumulatedUsage = value.accumulatedUsage;
      contextUsage = value.contextUsage;
      maxToolCallsReached = value.maxToolCallsReached ?? false;
      if (value.cancelled) {
        // Persist BEFORE yielding — the consumer may stop iterating after seeing cancelled
        fixUnmatchedToolCalls(extraMessages);
        for (const message of extraMessages) await addMessage(sessionId, message);
        const cancelledMsg: Message = { id: generateId(), role: "assistant", content: finalText ? `${finalText}\n\n*(已取消)*` : "*(已取消)*", timestamp: new Date().toISOString() };
        await addMessage(sessionId, cancelledMsg);
        await persistSessionRuntimeMeta(sessionId, run.providerName, run.model, run.thinkingEffort);
        yield { chunk: "", done: true, cancelled: true };
        return { sessionId, userMessage, assistantMessage: cancelledMsg, usage: undefined, contextUsage: undefined };
      }
      if (value.denied) {
        for (const message of extraMessages) await addMessage(sessionId, message);
        await persistSessionRuntimeMeta(sessionId, run.providerName, run.model, run.thinkingEffort);
        yield { chunk: "", done: true };
        const dummyAssistant: Message = { id: generateId(), role: "assistant", content: "", timestamp: new Date().toISOString() };
        return { sessionId, userMessage, assistantMessage: dummyAssistant, usage: undefined, contextUsage: undefined };
      }
      break;
    }

    if (value.type === "reasoning") {
      options.onReasoningChunk?.(value.text);
      yield { chunk: value.text, done: false, reasoning: true };
    } else if (value.type === "textChunk") {
      hasStreamedText = true;
      yield { chunk: value.text, done: false };
    } else if (value.type === "toolCall") {
      options.onToolCall?.(value.name, value.input, value.callId);
    } else if (value.type === "toolResult") {
      options.onToolResult?.(value.name, value.content, value.isError, value.callId);
    }
  }

  for (const message of extraMessages) {
    await addMessage(sessionId, message);
  }

  const assistantMessage: Message = {
    id: generateId(),
    role: "assistant",
    content: resolveFinalAssistantContent(finalText, maxToolCallsReached),
    timestamp: new Date().toISOString(),
    ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
  };

  // Only send final content as a chunk if it wasn't already streamed via textChunks
  if (!hasStreamedText) {
    const finalContent = extractTextContent(assistantMessage.content);
    if (finalContent) {
      yield { chunk: finalContent, done: false };
    }
  }

  assistantMessage.metadata = { streamed: hasStreamedText };
  await addMessage(sessionId, assistantMessage);
  await persistSessionRuntimeMeta(sessionId, run.providerName, run.model, run.thinkingEffort);

  const usageRecord = buildUsageRecord(accumulatedUsage, run.providerName, run.model, sessionId,
    config.providers[run.providerName]?.models.find((m) => m.id === run.model)?.cost);
  const contextUsageRecord = buildUsageRecord(contextUsage, run.providerName, run.model, sessionId,
    config.providers[run.providerName]?.models.find((m) => m.id === run.model)?.cost);

  logger.debug("Chat completed", { session: session.title });
  yield { chunk: "", done: true, usage: usageRecord, contextUsage: contextUsageRecord };
  return { sessionId, userMessage, assistantMessage, usage: usageRecord, contextUsage: contextUsageRecord };
}

export function getChatContextPreview(session: Session, maxChars: number = 500): string {
  if (session.messages.length === 0) return "(empty session)";
  const lastMessages = session.messages.slice(-5);
  let preview = "";

  for (const msg of lastMessages) {
    const rolePreview = msg.role === "user" ? "User" : "Assistant";
    const textContent = extractTextContent(msg.content);
    const contentPreview = textContent.slice(0, 100) + (textContent.length > 100 ? "..." : "");
    preview += `${rolePreview}: ${contentPreview}\n`;
  }

  if (preview.length > maxChars) {
    preview = "...(truncated)...\n" + preview.slice(-maxChars);
  }

  return preview.trim();
}
