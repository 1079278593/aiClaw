import { describe, expect, it } from "vitest";
import { auditToolPath } from "./audit.js";

describe("write audit", () => {
  it("records the path and not the file contents", () => {
    expect(auditToolPath("write", { path: "inputs/a.md", content: "secret body" })).toBe("inputs/a.md");
    expect(auditToolPath("move", { path: "inputs/a.md", new_path: "knowledge_base/a.md", content: "nope" })).toBe(
      "inputs/a.md -> knowledge_base/a.md",
    );
    expect(auditToolPath("delete", { path: "inputs/a.md\nignored" })).toBe("inputs/a.md ignored");
  });
});