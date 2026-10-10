import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Config } from "../../config/index.js";
import { getPaths } from "../../config/paths.js";
import { createTriliumClient } from "../../trilium/client.js";
import {
  isTriliumBrowserPath,
  isTriliumEnabled,
  triliumChildBrowserPath,
  triliumNoteIdFromBrowserPath,
} from "../../trilium/paths.js";
import { triliumContentToPreview, triliumNoteKind } from "../../trilium/preview.js";
import { IMAGE_MIME_BY_EXT, isImageFile, isTextFile } from "./media.js";

export type DocBrowserEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};

const DOC_BROWSER_ROOTS = new Set(["knowledge_base", "inputs"]);

function normalizeDocBrowserPath(inputPath: string): string {
  return inputPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function resolveDocBrowserPath(inputPath: string): { relativePath: string; absolutePath: string } {
  const relativePath = normalizeDocBrowserPath(inputPath);
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Missing document path");
  if (!DOC_BROWSER_ROOTS.has(parts[0])) throw new Error("Document path not allowed");

  const absolutePath = resolve(getPaths().base, relativePath);
  const expectedRoot = resolve(getPaths().base, parts[0]);
  if (absolutePath !== expectedRoot && !absolutePath.startsWith(expectedRoot + sep)) {
    throw new Error("Document path not allowed");
  }
  return { relativePath, absolutePath };
}

async function listTriliumEntries(inputPath: string, config: Config): Promise<{ path: string; entries: DocBrowserEntry[] }> {
  if (!isTriliumEnabled(config.tools.trilium.enabled, config.tools.trilium.token)) {
    throw new Error("Trilium 未启用");
  }
  const relativePath = normalizeDocBrowserPath(inputPath);
  const client = createTriliumClient(config.tools.trilium);
  const noteId = triliumNoteIdFromBrowserPath(relativePath);
  const notes = await client.listChildren(noteId);
  const entries = notes
    .map((note) => ({
      name: note.title || note.noteId,
      path: triliumChildBrowserPath(relativePath, note.noteId),
      kind: triliumNoteKind(note),
    }))
    .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, "zh-CN") : a.kind === "directory" ? -1 : 1);
  return { path: relativePath, entries };
}

async function readTriliumFile(inputPath: string, config: Config): Promise<{
  path: string;
  title?: string;
  content: string;
  supported: boolean;
  kind: "text" | "image" | "unsupported";
}> {
  if (!isTriliumEnabled(config.tools.trilium.enabled, config.tools.trilium.token)) {
    throw new Error("Trilium 未启用");
  }
  const relativePath = normalizeDocBrowserPath(inputPath);
  const noteId = triliumNoteIdFromBrowserPath(relativePath);
  if (!noteId) throw new Error("Missing document path");
  const client = createTriliumClient(config.tools.trilium);
  const note = await client.getNote(noteId);
  const raw = await client.getNoteContent(noteId);
  const preview = triliumContentToPreview(note, raw);
  return { path: relativePath, title: note.title, ...preview };
}

export async function listDocBrowserEntries(inputPath: string, config: Config): Promise<{ path: string; entries: DocBrowserEntry[] }> {
  if (isTriliumBrowserPath(inputPath)) {
    return listTriliumEntries(inputPath, config);
  }
  const { relativePath, absolutePath } = resolveDocBrowserPath(inputPath);
  const entries = (await readdir(absolutePath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: `${relativePath}/${entry.name}`.replaceAll("\\", "/"),
      kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    }))
    .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, "zh-CN") : a.kind === "directory" ? -1 : 1);
  return { path: relativePath, entries };
}

export async function readDocBrowserFile(inputPath: string, config: Config): Promise<{
  path: string;
  title?: string;
  content: string;
  supported: boolean;
  kind: "text" | "image" | "unsupported";
}> {
  if (isTriliumBrowserPath(inputPath)) {
    return readTriliumFile(inputPath, config);
  }
  const { relativePath, absolutePath } = resolveDocBrowserPath(inputPath);
  if (isImageFile(absolutePath)) {
    const mimeType = IMAGE_MIME_BY_EXT[extname(absolutePath).toLowerCase()];
    if (!mimeType) return { path: relativePath, content: "暂不支持预览", supported: false, kind: "unsupported" };
    const buffer = await readFile(absolutePath);
    return { path: relativePath, content: `data:${mimeType};base64,${buffer.toString("base64")}`, supported: true, kind: "image" };
  }
  if (!isTextFile(absolutePath)) {
    return { path: relativePath, content: "暂不支持预览", supported: false, kind: "unsupported" };
  }
  return { path: relativePath, content: await readFile(absolutePath, "utf-8"), supported: true, kind: "text" };
}

export async function writeDocBrowserFile(inputPath: string, content: string): Promise<void> {
  if (isTriliumBrowserPath(inputPath)) {
    throw new Error("Trilium 笔记为只读，不能在此编辑");
  }
  await writeFile(resolveDocBrowserPath(inputPath).absolutePath, content, "utf-8");
}
