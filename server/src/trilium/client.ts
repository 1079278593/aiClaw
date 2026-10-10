import type { TriliumToolConfig } from "../config/schema.js";

export class TriliumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriliumError";
  }
}

export type TriliumNote = {
  noteId: string;
  title: string;
  type: string;
  mime?: string;
  isProtected?: boolean;
  childNoteIds?: string[];
  parentNoteIds?: string[];
};

export type TriliumClient = {
  getNote(noteId: string): Promise<TriliumNote>;
  getNoteContent(noteId: string): Promise<string>;
  searchNotes(query: string, options?: { limit?: number }): Promise<TriliumNote[]>;
  listChildren(noteId?: string): Promise<TriliumNote[]>;
};

type FetchLike = typeof fetch;

const DEFAULT_ROOT_NOTE_ID = "root";
const MAX_CHILDREN = 200;

function normalizeEtapiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/etapi") ? trimmed : `${trimmed}/etapi`;
}

function formatEtapiError(status: number, body: string): string {
  const lowered = body.toLowerCase();
  if (status === 401 || status === 403) return "Trilium 认证失败，请检查 ETAPI token";
  if (lowered.includes("protect")) return "该笔记受保护，无法读取";
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // ignore
  }
  if (body.trim()) return body.trim().slice(0, 300);
  return `Trilium 请求失败 (${status})`;
}

export function createTriliumClient(config: TriliumToolConfig, fetchImpl: FetchLike = fetch): TriliumClient {
  const base = normalizeEtapiBase(config.baseUrl);
  const ancestorNoteId = config.ancestorNoteId.trim();

  async function request(pathname: string, search?: Record<string, string>): Promise<{ status: number; text: string; contentType: string }> {
    const url = new URL(`${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    if (search) {
      for (const [key, value] of Object.entries(search)) {
        if (value) url.searchParams.set(key, value);
      }
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: config.token.trim() },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TriliumError(`无法连接 Trilium：${message}`);
    }
    const text = await response.text();
    return { status: response.status, text, contentType: response.headers.get("content-type") || "" };
  }

  async function requestJson<T>(pathname: string, search?: Record<string, string>): Promise<T> {
    const { status, text } = await request(pathname, search);
    if (status < 200 || status >= 300) throw new TriliumError(formatEtapiError(status, text));
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TriliumError("Trilium 返回了无法解析的 JSON");
    }
  }

  async function getNote(noteId: string): Promise<TriliumNote> {
    const note = await requestJson<TriliumNote>(`/notes/${encodeURIComponent(noteId)}`);
    if (note.isProtected) throw new TriliumError("该笔记受保护，无法读取");
    return note;
  }

  async function getNoteContent(noteId: string): Promise<string> {
    const note = await getNote(noteId);
    const { status, text } = await request(`/notes/${encodeURIComponent(note.noteId)}/content`);
    if (status < 200 || status >= 300) throw new TriliumError(formatEtapiError(status, text));
    return text;
  }

  async function searchNotes(query: string, options?: { limit?: number }): Promise<TriliumNote[]> {
    const search = query.trim() || "*";
    const data = await requestJson<{ results?: TriliumNote[] }>("/notes", {
      search,
      ...(ancestorNoteId ? { ancestorNoteId } : {}),
      ...(options?.limit ? { limit: String(options.limit) } : {}),
    });
    return (data.results ?? []).filter((note) => !note.isProtected);
  }

  async function listChildren(noteId?: string): Promise<TriliumNote[]> {
    const parentId = noteId?.trim() || ancestorNoteId || DEFAULT_ROOT_NOTE_ID;
    const parent = await getNote(parentId);
    const childIds = (parent.childNoteIds ?? []).slice(0, MAX_CHILDREN);
    const children = await Promise.all(childIds.map(async (id) => {
      try {
        return await getNote(id);
      } catch (error) {
        if (error instanceof TriliumError && error.message.includes("受保护")) return null;
        throw error;
      }
    }));
    return children.filter((note): note is TriliumNote => Boolean(note));
  }

  return { getNote, getNoteContent, searchNotes, listChildren };
}
