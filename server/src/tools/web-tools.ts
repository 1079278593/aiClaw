/**
 * Web tools backed by the configured search provider.
 */

import { isIP } from "node:net";
import { tavily, type TavilyClient, type TavilyExtractResponse, type TavilySearchResponse } from "@tavily/core";
import type { TavilyToolConfig } from "../config/index.js";
import type { ToolDefinition, ToolResult } from "./types.js";

type WebSearchInput = {
  query: string;
};

type WebFetchInput = {
  url?: string;
  urls?: string[];
};

export type WebClient = Pick<TavilyClient, "search" | "extract">;

const MAX_FETCH_URLS = 5;

function truncateText(value: unknown, maxChars: number): string {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n[content truncated]`;
}

function formatError(prefix: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: `${prefix}: ${message}`, isError: true };
}

function timeoutSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000);
}

function makeClient(config: TavilyToolConfig): WebClient {
  return tavily({
    apiKey: config.apiKey,
    apiBaseURL: config.baseUrl,
  });
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function assertPublicHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Blocked local URL: ${value}`);
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateIPv4(hostname)) {
    throw new Error(`Blocked private network URL: ${value}`);
  }
  if (ipVersion === 6 && isBlockedIPv6(hostname)) {
    throw new Error(`Blocked private network URL: ${value}`);
  }

  return parsed.toString();
}

function collectFetchUrls(input: WebFetchInput): string[] {
  const candidates: string[] = [];
  if (typeof input.url === "string" && input.url.trim()) candidates.push(input.url.trim());
  if (Array.isArray(input.urls)) {
    for (const value of input.urls) {
      if (typeof value === "string" && value.trim()) candidates.push(value.trim());
    }
  }

  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) throw new Error("url or urls is required");
  if (unique.length > MAX_FETCH_URLS) throw new Error(`web_fetch supports at most ${MAX_FETCH_URLS} URLs`);
  return unique.map(assertPublicHttpUrl);
}

function formatSearchResults(response: TavilySearchResponse, maxContentChars: number): string {
  if (!Array.isArray(response.results) || response.results.length === 0) {
    return "Search results:\nNo results found.";
  }

  const lines = ["Search results:"];
  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || "Untitled"}`);
    lines.push(`   URL: ${result.url}`);
    lines.push(`   Content: ${truncateText(result.content, maxContentChars)}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function formatFetchResults(response: TavilyExtractResponse, maxFetchedChars: number): string {
  const lines = ["Fetch results:"];
  if (Array.isArray(response.results)) {
    response.results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title || "Untitled"}`);
      lines.push(`   URL: ${result.url}`);
      lines.push("   Content:");
      lines.push(truncateText(result.rawContent, maxFetchedChars));
      lines.push("");
    });
  }

  if (Array.isArray(response.failedResults)) {
    for (const failed of response.failedResults) {
      lines.push(`Failed: ${failed.url}`);
      lines.push(`Reason: ${failed.error}`);
      lines.push("");
    }
  }

  if (lines.length === 1) lines.push("No content fetched.");
  return lines.join("\n").trimEnd();
}

function makeWebSearchTool(config: TavilyToolConfig, client: WebClient): ToolDefinition<WebSearchInput> {
  return {
    name: "web_search",
    description: "搜索网页并返回简洁的带引用结果。当用户明确要求搜索网页或获取当前外部信息时使用此工具。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
    async execute(input) {
      try {
        const query = String(input.query ?? "").trim();
        if (!query) return { content: "Web search failed: query is required.", isError: true };
        const response = await client.search(query, {
          searchDepth: config.searchDepth,
          maxResults: config.maxResults,
          topic: "general",
          includeAnswer: config.includeAnswer,
          includeRawContent: false,
          includeUsage: config.includeUsage,
          timeout: timeoutSeconds(config.timeoutMs),
        });
        return { content: formatSearchResults(response, config.maxSearchContentChars) };
      } catch (error) {
        return formatError("Web search failed", error);
      }
    },
  };
}

function makeWebFetchTool(config: TavilyToolConfig, client: WebClient): ToolDefinition<WebFetchInput> {
  return {
    name: "web_fetch",
    description: "通过 URL 获取一个或多个网页的可读详细内容。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要获取的单个网页 URL" },
        urls: {
          type: "array",
          description: `要获取的网页 URL 列表，最多 ${MAX_FETCH_URLS} 个`,
          items: { type: "string" },
        },
      },
    },
    async execute(input) {
      try {
        const urls = collectFetchUrls(input);
        const response = await client.extract(urls, {
          extractDepth: config.fetchDepth,
          format: config.fetchFormat,
          includeUsage: config.includeUsage,
          timeout: timeoutSeconds(config.timeoutMs),
        });
        return { content: formatFetchResults(response, config.maxFetchedChars) };
      } catch (error) {
        return formatError("Web fetch failed", error);
      }
    },
  };
}

export function createWebTools(config: TavilyToolConfig, client?: WebClient): ToolDefinition[] {
  if (!config.enabled || !config.apiKey.trim()) return [];
  const webClient = client ?? makeClient(config);
  return [
    makeWebSearchTool(config, webClient),
    makeWebFetchTool(config, webClient),
  ];
}
