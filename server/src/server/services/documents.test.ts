import { describe, expect, it } from "vitest";
import { writeDocBrowserFile } from "./documents.js";

describe("documents", () => {
  it("rejects writes to Trilium paths", async () => {
    await expect(writeDocBrowserFile("trilium/abc", "x")).rejects.toThrow("只读");
    await expect(writeDocBrowserFile("trilium", "x")).rejects.toThrow("只读");
  });
});
