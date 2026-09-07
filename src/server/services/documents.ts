import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { getPaths } from "../../config/paths.js";
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

export async function listDocBrowserEntries(inputPath: string): Promise<{ path: string; entries: DocBrowserEntry[] }> {
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

export async function readDocBrowserFile(inputPath: string): Promise<{
  path: string;
  content: string;
  supported: boolean;
  kind: "text" | "image" | "unsupported";
}> {
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
  await writeFile(resolveDocBrowserPath(inputPath).absolutePath, content, "utf-8");
}
