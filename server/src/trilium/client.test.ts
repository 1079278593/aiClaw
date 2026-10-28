import { describe, expect, it, vi } from "vitest";
import { createTriliumClient, TriliumError } from "./client.js";
import type { TriliumToolConfig } from "../config/schema.js";

const config: TriliumToolConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8080",
  token: "etapi-token",
  ancestorNoteId: "folder1",
  timeoutMs: 5_000,
};

function jsonResponse(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

describe("trilium client", () => {
  it("searches under ancestorNoteId and skips protected notes", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url).toContain("/etapi/notes");
      expect(url).toContain("ancestorNoteId=folder1");
      expect(url).toContain("search=wiki");
      return jsonResponse(200, {
        results: [
          { noteId: "n1", title: "公开", type: "text", isProtected: false },
          { noteId: "n2", title: "机密", type: "text", isProtected: true },
        ],
      });
    }) as typeof fetch;

    const client = createTriliumClient(config, fetchImpl);
    const notes = await client.searchNotes("wiki");
    expect(notes.map((note) => note.noteId)).toEqual(["n1"]);
  });

  it("lists children and maps protected child errors", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/notes/folder1") && !url.includes("/content")) {
        return jsonResponse(200, { noteId: "folder1", title: "根", type: "book", isProtected: false, childNoteIds: ["c1", "c2"] });
      }
      if (url.includes("/notes/c1")) {
        return jsonResponse(200, { noteId: "c1", title: "子一", type: "text", isProtected: false, childNoteIds: [] });
      }
      return jsonResponse(400, { message: "Note is protected" });
    }) as typeof fetch;

    const client = createTriliumClient(config, fetchImpl);
    const children = await client.listChildren();
    expect(children).toEqual([{ noteId: "c1", title: "子一", type: "text", isProtected: false, childNoteIds: [] }]);
  });

  it("reads note content after checking protection", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/content")) return new Response("<p>Hello</p>", { status: 200 });
      return jsonResponse(200, { noteId: "n1", title: "Hello", type: "text", isProtected: false });
    }) as typeof fetch;

    const client = createTriliumClient(config, fetchImpl);
    await expect(client.getNoteContent("n1")).resolves.toBe("<p>Hello</p>");
  });

  it("surfaces protected notes as a Chinese error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      noteId: "secret",
      title: "机密",
      type: "text",
      isProtected: true,
    })) as typeof fetch;
    const client = createTriliumClient(config, fetchImpl);
    await expect(client.getNote("secret")).rejects.toBeInstanceOf(TriliumError);
    await expect(client.getNote("secret")).rejects.toThrow("受保护");
  });
});
