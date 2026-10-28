import { randomUUID } from "node:crypto";
import type { Config, ProviderName } from "../config/index.js";
import { chatStream } from "../chat/index.js";
import type { UsageRecord } from "../llm/types.js";
import type { getLogger } from "../logger/index.js";
import { loadSession } from "../session/index.js";
import type { Client } from "./protocol.js";
import { sendToClient } from "./send.js";
import { buildAugmentedUserContent } from "./services/chat-content.js";
import { normalizeImageDataUrl } from "../media/image.js";
import { appendUsageRecord } from "./services/usage-store.js";
import { buildPersonContextSuffix, personIdFromThreadPath } from "../people/context.js";
import { ORGANIZE_USER_TEXT, applyOrganizeResult, buildOrganizeMaterials, splitOrganizeReply, visibleBeforeMarker } from "../people/organize.js";
import { entriesAfter, getPersonRecord, readEntries } from "../people/store.js";
import { replaceLastAssistantContent } from "../session/index.js";

const WRITE_PERMISSION_TOOLS = new Set(["write", "edit", "delete", "move", "web_search", "web_fetch"]);

export function requiresToolPermission(client: Pick<Client, "writePermOpen">, toolName: string): boolean {
  return WRITE_PERMISSION_TOOLS.has(toolName) && !client.writePermOpen;
}

/** Active chat operations, keyed by sessionId. */
const activeChats = new Map<string, { controller: AbortController; runId: string }>();

export function cancelChat(
  sessionId: string,
  pendingPermissions?: Map<string, { resolve: (allowed: boolean) => void; sessionId: string }>,
): boolean {
  const activeChat = activeChats.get(sessionId);
  let cancelled = false;
  if (activeChat) {
    activeChat.controller.abort();
    activeChats.delete(sessionId);
    cancelled = true;
  }
  if (pendingPermissions) {
    for (const [requestId, entry] of pendingPermissions) {
      if (entry.sessionId === sessionId) {
        entry.resolve(false);
        pendingPermissions.delete(requestId);
        cancelled = true;
      }
    }
  }
  return cancelled;
}

function getModelModal(config: Config, provider: ProviderName, model: string): "l" | "vl" {
  return config.providers[provider]?.models.find((item) => item.id === model)?.modal ?? "l";
}

function buildPermissionDetails(toolName: string, input: Record<string, unknown>): Record<string, string> {
  const str = (value: unknown, max: number) => String(value ?? "").slice(0, max);
  const list = (value: unknown, max: number) => Array.isArray(value)
    ? value.map((item) => String(item)).join("\n").slice(0, max)
    : str(value, max);
  if (toolName === "write") return { path: str(input.path, 200), preview: str(input.content, 100) };
  if (toolName === "edit") return { path: str(input.path, 200), oldPreview: str(input.old_string, 80), newPreview: str(input.new_string, 80) };
  if (toolName === "delete") return { path: str(input.path, 200) };
  if (toolName === "move") return { path: str(input.path, 200), newPath: str(input.new_path, 200) };
  if (toolName === "web_search") return { query: str(input.query, 500) };
  if (toolName === "web_fetch") return { urls: input.url ? str(input.url, 1000) : list(input.urls, 1000) };
  return {};
}

export async function processChatMessage(options: {
  client: Client;
  sessionId: string;
  content: string;
  images?: Array<{ url: string; path?: string }>;
  provider: ProviderName;
  model: string;
  thinkingEffort?: string;
  previewPath?: string;
  selectedPreviewText?: string;
  threadPath?: string;
  captureJob?: "organize";
  pendingPermissions: Map<string, { resolve: (allowed: boolean) => void; sessionId: string }>;
  config: Config;
  logger: ReturnType<typeof getLogger>;
}): Promise<void> {
  const { client, sessionId, content, images, provider, model, thinkingEffort, previewPath, selectedPreviewText, threadPath, captureJob, pendingPermissions, config, logger } = options;
  
  // Abort any existing chat for this session
  cancelChat(sessionId, pendingPermissions);
  const runId = randomUUID();
  const controller = new AbortController();
  activeChats.set(sessionId, { controller, runId });
  let sequence = 0;
  const sendChatEvent = <T extends { type: string }>(event: T): void => {
    sendToClient(client, { ...event, sessionId, runId, sequence: ++sequence } as Parameters<typeof sendToClient>[1]);
  };

  try {
    if (images?.length && getModelModal(config, provider, model) !== "vl") {
      sendToClient(client, { type: "error", sessionId, message: "当前模型不支持图片，请切换到视觉模型后再发送" });
      return;
    }

    let normalizedImages = images;
    try {
      normalizedImages = images?.length
        ? await Promise.all(images.map(async (image) => ({ ...image, url: await normalizeImageDataUrl(image.url) })))
        : images;
    } catch (error) {
      sendToClient(client, { type: "error", sessionId, message: (error as Error).message });
      return;
    }
    const personId = personIdFromThreadPath(threadPath);
    let contextSuffix: string | undefined;
    let visibleContent = content;
    let organizeLastAt: string | undefined;
    const organizing = captureJob === "organize";
    if (captureJob && captureJob !== "organize") {
      sendToClient(client, { type: "error", sessionId, message: "未知的整理任务" });
      return;
    }
    if (organizing && !personId) {
      sendToClient(client, { type: "error", sessionId, message: "没有选中的人" });
      return;
    }
    if (personId) {
      let record: Awaited<ReturnType<typeof getPersonRecord>>;
      try {
        record = await getPersonRecord(personId);
      } catch {
        sendToClient(client, { type: "error", sessionId, message: "文件不存在或已被删除" });
        return;
      }
      if (organizing) {
        const fresh = entriesAfter(await readEntries(personId), record.person.organizedAt);
        if (fresh.length === 0) {
          sendToClient(client, { type: "error", sessionId, message: "没有新的原文" });
          return;
        }
        organizeLastAt = fresh.at(-1)?.at;
        visibleContent = ORGANIZE_USER_TEXT;
        contextSuffix = buildOrganizeMaterials(record.digest, record.profile, fresh);
      } else {
        contextSuffix = buildPersonContextSuffix({
          id: personId,
          profile: record.profile,
          previewPath,
          selectedPreviewText,
        });
      }
    }

    const userMessageId = randomUUID();
    sendChatEvent({ type: "chatStart", userMessageId });
    const { llmUserContent, persistedUserContent } = buildAugmentedUserContent(
      visibleContent,
      organizing ? undefined : normalizedImages,
      organizing ? undefined : previewPath,
      organizing ? undefined : selectedPreviewText,
      contextSuffix ? { contextSuffix, persistPlain: true } : undefined,
    );
    let fullResponse = "";
    let rawResponse = "";
    let usage: UsageRecord | undefined;
    let contextUsage: UsageRecord | undefined;

    for await (const result of chatStream(sessionId, llmUserContent, config, {
      provider,
      model,
      thinkingEffort,
      persistedUserContent,
      userMessageId,
      signal: controller.signal,
      omitTools: organizing,
      onToolCall: (name, input, callId) => sendChatEvent({ type: "toolCall", name, input, callId }),
      onToolResult: (name, resultContent, isError, callId) => sendChatEvent({ type: "toolResult", name, content: resultContent, isError, callId }),
      checkPermission: async (toolName, input) => {
        if (!requiresToolPermission(client, toolName)) return true;
        const requestId = randomUUID();
        sendChatEvent({
          type: "toolPermissionRequest",
          requestId,
          toolName,
          details: buildPermissionDetails(toolName, input),
        });
        return new Promise<boolean>((resolve) => pendingPermissions.set(requestId, { resolve, sessionId }));
      },
    })) {
      if (!result.done) {
        if (result.reasoning) sendChatEvent({ type: "chatReasoning", chunk: result.chunk });
        else if (organizing) {
          rawResponse += result.chunk;
          const visible = visibleBeforeMarker(rawResponse);
          const delta = visible.slice(fullResponse.length);
          if (delta) {
            fullResponse = visible;
            sendChatEvent({ type: "chatChunk", chunk: delta });
          }
        } else {
          fullResponse += result.chunk;
          sendChatEvent({ type: "chatChunk", chunk: result.chunk });
        }
      } else {
        if (result.cancelled) {
          sendChatEvent({ type: "chatCancelled", fullResponse });
          return;
        }
        usage = result.usage;
        contextUsage = result.contextUsage;
      }
    }

    if (organizing) {
      const split = splitOrganizeReply(rawResponse);
      const delta = split.brief.slice(fullResponse.length);
      if (delta) {
        fullResponse = split.brief;
        sendChatEvent({ type: "chatChunk", chunk: delta });
      } else {
        fullResponse = split.brief;
      }
      await replaceLastAssistantContent(sessionId, split.brief);
      if (!split.brief) {
        sendToClient(client, { type: "error", sessionId, runId, sequence: ++sequence, message: "整理没有写出正文" });
        return;
      }
      try {
        await applyOrganizeResult(personId!, rawResponse, organizeLastAt);
      } catch (error) {
        sendToClient(client, { type: "error", sessionId, runId, sequence: ++sequence, message: (error as Error).message });
        return;
      }
    }

    if (usage) await appendUsageRecord(usage);
    const summarize = (record: UsageRecord | undefined) => record ? {
      model: record.model,
      provider: record.provider,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      billingOutputTokens: record.billingOutputTokens,
      thinkingTokens: record.thinkingTokens,
      cachedReadTokens: record.cachedReadTokens,
      cachedWriteTokens: record.cachedWriteTokens,
      cost: record.cost,
    } : undefined;
    sendChatEvent({ type: "chatEnd", fullResponse, usage: summarize(usage), contextUsage: summarize(contextUsage) });
    logger.info(`Chat completed: ${(await loadSession(sessionId)).title}`);
  } catch (error) {
    logger.error(`Chat processing error: ${(error as Error).message}`);
    sendToClient(client, { type: "error", sessionId, runId, sequence: ++sequence, message: `Chat failed: ${(error as Error).message}` });
  } finally {
    if (activeChats.get(sessionId)?.runId === runId) activeChats.delete(sessionId);
  }
}
