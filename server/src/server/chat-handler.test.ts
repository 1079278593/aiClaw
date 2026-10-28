import { describe, expect, it } from "vitest";
import { requiresToolPermission } from "./chat-handler.js";

describe("requiresToolPermission", () => {
  it("reads the current connection permission state for each tool call", () => {
    const client = { writePermOpen: false };

    expect(requiresToolPermission(client, "write")).toBe(true);
    expect(requiresToolPermission(client, "read")).toBe(false);

    client.writePermOpen = true;
    expect(requiresToolPermission(client, "write")).toBe(false);
  });
});
