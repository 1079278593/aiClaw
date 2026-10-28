import { readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Config } from "../../config/index.js";
import { getPaths } from "../../config/paths.js";
import { createTriliumClient } from "../../trilium/client.js";
import { formatTriliumRef, isTriliumEnabled } from "../../trilium/paths.js";

export type FileSummary = {
  path: string;
  source: string;
  name?: string;
};

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_BY_EXT));
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".svg",
  ".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".ogg", ".flac",
  ".zip", ".tar", ".gz", ".rar", ".7z", ".exe", ".dll", ".so", ".bin",
  ".pdf", ".woff", ".woff2", ".ttf", ".eot",
]);

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isTextFile(filePath: string): boolean {
  return !BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function getAllowedRoots(config: Config): Array<{ root: string; source: string }> {
  const base = getPaths().base;
  return config.fs.allowedDirs.map((dir) => ({ source: dir, root: resolve(base, dir) }));
}

async function collectFiles(root: string, source: string, accepts: (filePath: string) => boolean): Promise<FileSummary[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: FileSummary[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, source, accepts));
      continue;
    }
    if (!entry.isFile() || !accepts(fullPath)) continue;
    const rel = relative(resolve(getPaths().base, source), fullPath).replaceAll("\\", "/");
    files.push({ source, path: `${source}/${rel}` });
  }
  return files;
}

async function listTriliumFiles(config: Config, query: string): Promise<FileSummary[]> {
  if (!isTriliumEnabled(config.tools.trilium.enabled, config.tools.trilium.token)) return [];
  const client = createTriliumClient(config.tools.trilium);
  const notes = query.trim()
    ? await client.searchNotes(query, { limit: 50 })
    : await client.listChildren();
  return notes.slice(0, 50).map((note) => ({
    source: "trilium",
    path: formatTriliumRef(note.noteId),
    name: note.title,
  }));
}

export async function listAllowedFiles(config: Config, query: string): Promise<FileSummary[]> {
  const all = (await Promise.all(
    getAllowedRoots(config).map(({ root, source }) => collectFiles(root, source, (filePath) => isTextFile(filePath) || isImageFile(filePath))),
  )).flat();
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery ? all.filter((file) => file.path.toLowerCase().includes(normalizedQuery)) : all;
  let triliumFiles: FileSummary[] = [];
  try {
    triliumFiles = await listTriliumFiles(config, query);
  } catch {
    triliumFiles = [];
  }
  return [...filtered, ...triliumFiles].slice(0, 200).sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}

export function resolveAllowedImagePath(config: Config, inputPath: string): string {
  const resolved = resolve(getPaths().base, inputPath.replaceAll("\\", "/"));
  for (const { root } of getAllowedRoots(config)) {
    if (resolved === root || resolved.startsWith(root + sep)) return resolved;
  }
  throw new Error("Image path not allowed");
}
