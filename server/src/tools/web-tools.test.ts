import { describe, expect, it, vi } from "vitest";
import type { TavilyToolConfig } from "../config/index.js";
import { createWebTools } from "./web-tools.js";

const baseConfig: TavilyToolConfig = {
  enabled: true,
  apiKey: "tvly-test",
  baseUrl: "https://api.tavily.com",
  searchDepth: "basic",
  maxResults: 10,
  includeAnswer: false,
  includeRawContent: false,
  includeUsage: false,
  timeoutMs: 30_000,
  maxSearchContentChars: 20,
  fetchDepth: "basic",
  fetchFormat: "markdown",
  maxFetchedChars: 30,
};

function makeClient() {
  return {
    search: vi.fn(async () => ({
      query: "test query",
      responseTime: 1,
      images: [],
      results: [
        {
          title: "Result title",
          url: "https://example.com/a",
          content: "This is a long search result content that should be truncated.",
          rawContent: "raw should not appear",
          score: 0.99,
          publishedDate: "2026-01-01",
        },
      ],
      requestId: "req-1",
    })),
    extract: vi.fn(async () => ({
      responseTime: 1,
      results: [
        {
          title: "Fetched page",
          url: "https://example.com/a",
          rawContent: "# Heading\n\nThis fetched content should be truncated.",
        },
      ],
      failedResults: [],
      requestId: "req-2",
    })),
  };
}

describe("web tools", () => {
  it("does not create tools when disabled or missing api key", () => {
    expect(createWebTools({ ...baseConfig, enabled: false })).toEqual([]);
    expect(createWebTools({ ...baseConfig, apiKey: "" })).toEqual([]);
  });

  it("search sends configured defaults and formats only title/url/content", async () => {
    const client = makeClient();
    const [searchTool] = createWebTools(baseConfig, client);

    const result = await searchTool.execute({ query: "latest news" });

    expect(client.search).toHaveBeenCalledWith("latest news", {
      searchDepth: "basic",
      maxResults: 10,
      topic: "general",
      includeAnswer: false,
      includeRawContent: false,
      includeUsage: false,
      timeout: 30,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Search results:");
    expect(result.content).toContain("Result title");
    expect(result.content).toContain("https://example.com/a");
    expect(result.content).toContain("[content truncated]");
    expect(result.content).not.toContain("raw should not appear");
    expect(result.content).not.toContain("0.99");
    expect(result.content).not.toContain("req-1");
  });

  it("fetch validates URLs, sends configured defaults, and truncates content", async () => {
    const client = makeClient();
    const [, fetchTool] = createWebTools(baseConfig, client);

    const result = await fetchTool.execute({ url: "https://example.com/a" });

    expect(client.extract).toHaveBeenCalledWith(["https://example.com/a"], {
      extractDepth: "basic",
      format: "markdown",
      includeUsage: false,
      timeout: 30,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Fetch results:");
    expect(result.content).toContain("Fetched page");
    expect(result.content).toContain("[content truncated]");
  });

  it("fetch rejects local and private network URLs", async () => {
    const client = makeClient();
    const [, fetchTool] = createWebTools(baseConfig, client);

    const local = await fetchTool.execute({ url: "http://localhost:3000" });
    const privateIp = await fetchTool.execute({ url: "http://192.168.1.1" });
    const ipv6Loopback = await fetchTool.execute({ url: "http://[::1]/" });

    expect(local.isError).toBe(true);
    expect(privateIp.isError).toBe(true);
    expect(ipv6Loopback.isError).toBe(true);
    expect(client.extract).not.toHaveBeenCalled();
  });
});

