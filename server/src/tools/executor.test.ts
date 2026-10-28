/**
 * Tool executor tests
 */

import { describe, it, expect } from "vitest";
import { executeTool } from "./executor.js";
import type { ToolDefinition } from "./types.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echo input",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(input) {
    return { content: (input as { text: string }).text };
  },
};

const errorTool: ToolDefinition = {
  name: "fail",
  description: "Always throws",
  inputSchema: { type: "object" },
  async execute() {
    throw new Error("intentional failure");
  },
};

describe("executeTool", () => {
  it("returns error result for unknown tool", async () => {
    const result = await executeTool("nonexistent", {}, [echoTool]);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nonexistent");
  });

  it("executes known tool and returns result", async () => {
    const result = await executeTool("echo", { text: "hello" }, [echoTool]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("hello");
  });

  it("catches tool execution errors and returns error result", async () => {
    const result = await executeTool("fail", {}, [errorTool]);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("intentional failure");
  });
});
