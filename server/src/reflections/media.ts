/**
 * 心得文内媒体：sidecar 路径、标记约定、读写。
 * 标记形态见 mobile/docs/api_shapes.md §8。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ReflectionsError,
  ROOT_REL,
  normalizeRel,
  reflectionsRoot,
  resolveReflectionPath,
} from "./paths.js";

export const ASSETS_SUFFIX = ".assets";

const AUDIO_MIME: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".webm": "audio/webm",
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_BYTES = 25 * 1024 * 1024;

export function isAssetsDirName(name: string): boolean {
  return name.endsWith(ASSETS_SUFFIX);
}

export function reflectionStem(mdRelativePath: string): string {
  const base = path.posix.basename(mdRelativePath);
  const ext = path.posix.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function assetsDirRelative(mdRelativePath: string): string {
  const dir = path.posix.dirname(mdRelativePath);
  return `${dir}/${reflectionStem(mdRelativePath)}${ASSETS_SUFFIX}`;
}

/** md 内引用：`./«stem».assets/file.ext` */
export function relativeMediaSrc(mdRelativePath: string, filename: string): string {
  return `./${reflectionStem(mdRelativePath)}${ASSETS_SUFFIX}/${filename}`;
}

export function newMediaId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (const byte of randomBytes(2)) suffix += alphabet[byte % alphabet.length];
  return `${stamp}_${suffix}`;
}

export function formatAudioMarker(id: string, src: string, transcript = ""): string {
  const body = transcript.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return `:::aiclaw-audio[id=${id} src="${src}"]\n${body}\n:::`;
}

export function formatImageMarkdown(src: string, alt = ""): string {
  return `![${alt}](${src})`;
}

/** 把 `./stem.assets/x` 解析成仓库相对路径（基于篇 md 路径）。 */
export function resolveMediaRelFromNote(notePath: string, src: string): string {
  const normalized = src.replaceAll("\\", "/").trim();
  const dir = path.posix.dirname(notePath);
  if (normalized.startsWith("./")) return path.posix.normalize(`${dir}/${normalized.slice(2)}`);
  if (normalized.startsWith("inputs/reflections/")) return path.posix.normalize(normalized);
  return path.posix.normalize(`${dir}/${normalized}`);
}

function mimeFromExt(ext: string): string {
  const lower = ext.toLowerCase();
  return AUDIO_MIME[lower] || IMAGE_MIME[lower] || "application/octet-stream";
}

function pickExt(input: { filename?: string; mime?: string; kind?: "audio" | "image" }): string {
  const fromName = path.extname(input.filename || "").toLowerCase();
  if (fromName && (AUDIO_MIME[fromName] || IMAGE_MIME[fromName])) return fromName;
  const mime = (input.mime || "").toLowerCase();
  for (const [ext, type] of Object.entries({ ...AUDIO_MIME, ...IMAGE_MIME })) {
    if (type === mime) return ext;
  }
  if (input.kind === "image") return ".jpg";
  return ".m4a";
}

export async function ensureAssetsDir(mdPath: string, userDataDir?: string): Promise<{
  relativeDir: string;
  absoluteDir: string;
}> {
  const { relativePath, absolutePath } = resolveReflectionPath(mdPath, userDataDir);
  try {
    await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReflectionsError("文件不存在或已被删除", 404);
    }
    throw error;
  }
  const relativeDir = assetsDirRelative(relativePath);
  const absoluteDir = path.resolve(path.dirname(absolutePath), path.basename(relativeDir));
  await mkdir(absoluteDir, { recursive: true });
  return { relativeDir, absoluteDir };
}

export async function writeReflectionMedia(input: {
  path: string;
  data: Buffer;
  filename?: string;
  mime?: string;
  kind?: "audio" | "image";
  transcript?: string;
  userDataDir?: string;
}): Promise<{
  id: string;
  relativeSrc: string;
  mediaPath: string;
  marker: string;
  kind: "audio" | "image";
}> {
  if (!input.data?.length) throw new ReflectionsError("缺少文件", 400);
  if (input.data.length > MAX_BYTES) throw new ReflectionsError("文件过大", 400);
  const { relativePath } = resolveReflectionPath(input.path, input.userDataDir);
  const { absoluteDir } = await ensureAssetsDir(relativePath, input.userDataDir);
  const id = newMediaId();
  const kind = input.kind || (IMAGE_MIME[pickExt(input)] ? "image" : "audio");
  const ext = pickExt({ ...input, kind });
  const filename = `${id}${ext}`;
  const absoluteFile = path.join(absoluteDir, filename);
  const tmp = `${absoluteFile}.${process.pid}.tmp`;
  await writeFile(tmp, input.data);
  await rename(tmp, absoluteFile);
  const relativeSrc = relativeMediaSrc(relativePath, filename);
  const mediaPath = resolveMediaRelFromNote(relativePath, relativeSrc);
  const marker = kind === "image"
    ? formatImageMarkdown(relativeSrc)
    : formatAudioMarker(id, relativeSrc, input.transcript || "");
  return { id, relativeSrc, mediaPath, marker, kind };
}

export async function readReflectionMediaFile(
  mediaRelPath: string,
  userDataDir?: string,
): Promise<{ absolutePath: string; mime: string; data: Buffer }> {
  const { absolutePath, relativePath } = resolveReflectionPath(mediaRelPath, userDataDir);
  // 只允许读 *.assets/ 下的文件
  const parts = relativePath.split("/");
  const assetsIdx = parts.findIndex((part) => isAssetsDirName(part));
  if (assetsIdx === -1 || assetsIdx >= parts.length - 1) {
    throw new ReflectionsError("不是心得附件路径", 400);
  }
  try {
    const data = await readFile(absolutePath);
    return { absolutePath, mime: mimeFromExt(path.extname(absolutePath)), data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReflectionsError("文件不存在或已被删除", 404);
    }
    throw error;
  }
}

/** 删除单个 sidecar 附件。正文仍在引用时拒绝，避免误删还在用的文件。 */
export async function deleteReflectionMedia(mediaRelPath: string, userDataDir?: string): Promise<void> {
  const { relativePath, absolutePath } = resolveReflectionPath(mediaRelPath, userDataDir);
  const parts = relativePath.split("/");
  const assetsIdx = parts.findIndex((part) => isAssetsDirName(part));
  if (assetsIdx === -1 || assetsIdx >= parts.length - 1) {
    throw new ReflectionsError("不是心得附件路径", 400);
  }
  const assetsRel = parts.slice(0, assetsIdx + 1).join("/");
  const stem = path.posix.basename(assetsRel).slice(0, -ASSETS_SUFFIX.length);
  const noteDir = path.posix.dirname(assetsRel);
  const filename = path.posix.basename(relativePath);
  for (const ext of [".md", ".txt"]) {
    const noteRel = `${noteDir}/${stem}${ext}`;
    try {
      const raw = await readFile(resolveReflectionPath(noteRel, userDataDir).absolutePath, "utf-8");
      if (raw.includes(filename)) {
        throw new ReflectionsError("正文仍在引用该附件，请先删掉正文里的引用", 409);
      }
    } catch (error) {
      if (error instanceof ReflectionsError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await rm(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReflectionsError("文件不存在或已被删除", 404);
    }
    throw error;
  }
}

export async function moveAssetsPair(fromMdRel: string, toMdRel: string, userDataDir?: string): Promise<void> {
  const fromAssetsRel = assetsDirRelative(fromMdRel);
  const toAssetsRel = assetsDirRelative(toMdRel);
  if (fromAssetsRel === toAssetsRel) return;
  const fromAbs = resolveReflectionPath(fromAssetsRel, userDataDir).absolutePath;
  const toAbs = resolveReflectionPath(toAssetsRel, userDataDir).absolutePath;
  try {
    await stat(fromAbs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await stat(toAbs);
    throw new ReflectionsError("目标附件目录已存在", 409);
  } catch (error) {
    if (error instanceof ReflectionsError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);
}

export async function deleteAssetsPair(mdRel: string, userDataDir?: string): Promise<void> {
  const assetsRel = assetsDirRelative(mdRel);
  const abs = resolveReflectionPath(assetsRel, userDataDir).absolutePath;
  await rm(abs, { recursive: true, force: true });
}

/** 文件名变更时改写正文里的 `./旧stem.assets/` 前缀。 */
export function rewriteAssetsPrefixInBody(body: string, oldStem: string, newStem: string): string {
  if (oldStem === newStem) return body;
  const from = `./${oldStem}${ASSETS_SUFFIX}/`;
  const to = `./${newStem}${ASSETS_SUFFIX}/`;
  return body.split(from).join(to);
}

export type OrphanAssets = {
  path: string;
  stem: string;
  folder: string;
};

async function walkAssetDirs(absDir: string, relDir: string, out: OrphanAssets[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(absDir, entry.name);
    const rel = normalizeRel(`${relDir}/${entry.name}`);
    if (isAssetsDirName(entry.name)) {
      const stem = entry.name.slice(0, -ASSETS_SUFFIX.length);
      const mdAbs = path.join(absDir, `${stem}.md`);
      const txtAbs = path.join(absDir, `${stem}.txt`);
      let hasNote = false;
      try {
        await stat(mdAbs);
        hasNote = true;
      } catch {
        try {
          await stat(txtAbs);
          hasNote = true;
        } catch {
          hasNote = false;
        }
      }
      if (!hasNote) {
        const folder = relDir === ROOT_REL ? "" : relDir.slice(ROOT_REL.length + 1);
        out.push({ path: rel, stem, folder });
      }
      continue;
    }
    await walkAssetDirs(abs, rel, out);
  }
}

/** 扫描无对应 md/txt 的 `*.assets` 目录。 */
export async function listOrphanAssets(userDataDir?: string): Promise<OrphanAssets[]> {
  const root = reflectionsRoot(userDataDir);
  const out: OrphanAssets[] = [];
  await walkAssetDirs(root, ROOT_REL, out);
  out.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  return out;
}

export type NoteAssetFile = {
  name: string;
  path: string;
  kind: "audio" | "image" | "other";
};

/** 列出某篇 sidecar 内文件（附件总览）。 */
export async function listNoteAssets(mdPath: string, userDataDir?: string): Promise<NoteAssetFile[]> {
  const { relativePath, absolutePath } = resolveReflectionPath(mdPath, userDataDir);
  try {
    await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReflectionsError("文件不存在或已被删除", 404);
    }
    throw error;
  }
  const assetsRel = assetsDirRelative(relativePath);
  const assetsAbs = path.join(path.dirname(absolutePath), path.basename(assetsRel));
  let entries;
  try {
    entries = await readdir(assetsAbs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: NoteAssetFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const kind = AUDIO_MIME[ext] ? "audio" : IMAGE_MIME[ext] ? "image" : "other";
    files.push({
      name: entry.name,
      path: normalizeRel(`${assetsRel}/${entry.name}`),
      kind,
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return files;
}
