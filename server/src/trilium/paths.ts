export const TRILIUM_ROOT = "trilium";
const TRILIUM_REF_PREFIX = "trilium:";

export function isTriliumEnabled(enabled: boolean, token: string): boolean {
  return enabled && Boolean(token.trim());
}

export function isTriliumBrowserPath(inputPath: string): boolean {
  const normalized = normalizeBrowserPath(inputPath);
  return normalized === TRILIUM_ROOT || normalized.startsWith(`${TRILIUM_ROOT}/`);
}

export function isTriliumRef(inputPath: string): boolean {
  return inputPath.startsWith(TRILIUM_REF_PREFIX);
}

export function normalizeBrowserPath(inputPath: string): string {
  return inputPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function triliumNoteIdFromBrowserPath(inputPath: string): string | undefined {
  const normalized = normalizeBrowserPath(inputPath);
  if (!isTriliumBrowserPath(normalized) || normalized === TRILIUM_ROOT) return undefined;
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

export function triliumChildBrowserPath(parentPath: string, noteId: string): string {
  const normalized = normalizeBrowserPath(parentPath);
  return `${normalized}/${noteId}`;
}

export function formatTriliumRef(noteId: string): string {
  return `${TRILIUM_REF_PREFIX}${noteId}`;
}

export function parseTriliumNoteId(input: string): string {
  const trimmed = input.trim();
  if (isTriliumRef(trimmed)) return trimmed.slice(TRILIUM_REF_PREFIX.length);
  if (isTriliumBrowserPath(trimmed)) {
    const fromPath = triliumNoteIdFromBrowserPath(trimmed);
    if (fromPath) return fromPath;
  }
  return trimmed;
}
