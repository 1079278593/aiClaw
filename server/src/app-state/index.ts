import fs from "node:fs/promises";
import { getPaths, pathExists } from "../config/paths.js";

export interface RecentModel {
  provider: string;
  model: string;
}

export interface AppState {
  lastActiveSessionId?: string;
  /** Mobile-only "reflections chat" session id. Never surfaces in the chat list
   *  and never overrides `lastActiveSessionId` (see plan_reflections_chat.md §7.4). */
  reflectionsSessionId?: string;
  recentModels: RecentModel[];
}

const MAX_RECENT_MODELS = 5;
const DEFAULT_APP_STATE: AppState = { recentModels: [] };

function normalizeRecentModels(value: unknown): RecentModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: RecentModel[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { provider, model } = item as { provider?: unknown; model?: unknown };
    if (typeof provider !== "string" || !provider.trim()) continue;
    if (typeof model !== "string" || !model.trim()) continue;
    const key = `${provider}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ provider, model });
  }
  return result.slice(0, MAX_RECENT_MODELS);
}

export async function loadAppState(userDataDir?: string): Promise<AppState> {
  const paths = getPaths(userDataDir);
  if (!(await pathExists(paths.appStateFile))) {
    return { ...DEFAULT_APP_STATE };
  }

  try {
    const raw = await fs.readFile(paths.appStateFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      lastActiveSessionId: typeof parsed.lastActiveSessionId === "string" ? parsed.lastActiveSessionId : undefined,
      reflectionsSessionId: typeof parsed.reflectionsSessionId === "string" ? parsed.reflectionsSessionId : undefined,
      recentModels: normalizeRecentModels(parsed.recentModels),
    };
  } catch {
    return { ...DEFAULT_APP_STATE };
  }
}

export async function saveAppState(state: AppState, userDataDir?: string): Promise<void> {
  const paths = getPaths(userDataDir);
  const normalizedState: AppState = {
    lastActiveSessionId: typeof state.lastActiveSessionId === "string" ? state.lastActiveSessionId : undefined,
    reflectionsSessionId: typeof state.reflectionsSessionId === "string" ? state.reflectionsSessionId : undefined,
    recentModels: normalizeRecentModels(state.recentModels),
  };
  await fs.mkdir(paths.files, { recursive: true });
  await fs.writeFile(paths.appStateFile, JSON.stringify(normalizedState, null, 2), "utf-8");
}

export async function setLastActiveSession(sessionId: string, userDataDir?: string): Promise<void> {
  const state = await loadAppState(userDataDir);
  // Idempotent: avoid rewriting app_state.json (and its git/mtime noise)
  // when the active session has not actually changed.
  if (state.lastActiveSessionId === sessionId) return;
  await saveAppState({ ...state, lastActiveSessionId: sessionId }, userDataDir);
}

/**
 * Record the mobile "reflections chat" session id.
 * Mirrors `setLastActiveSession` idempotency: same value never touches disk.
 */
export async function setReflectionsSession(sessionId: string, userDataDir?: string): Promise<void> {
  const state = await loadAppState(userDataDir);
  if (state.reflectionsSessionId === sessionId) return;
  await saveAppState({ ...state, reflectionsSessionId: sessionId }, userDataDir);
}

export async function clearReflectionsSession(userDataDir?: string): Promise<void> {
  const state = await loadAppState(userDataDir);
  if (state.reflectionsSessionId === undefined) return;
  const { reflectionsSessionId: _drop, ...rest } = state;
  await saveAppState(rest, userDataDir);
}

/** True when `sessionId` is the reflections chat session and must stay out of
 *  `lastActiveSessionId` / the regular chat list. */
export function isReflectionsSession(state: AppState, sessionId: string | undefined): boolean {
  return !!sessionId && state.reflectionsSessionId === sessionId;
}

export async function recordRecentModel(provider: string, model: string, userDataDir?: string): Promise<AppState> {
  const state = await loadAppState(userDataDir);
  const recentModels = [
    { provider, model },
    ...state.recentModels.filter((entry) => !(entry.provider === provider && entry.model === model)),
  ].slice(0, MAX_RECENT_MODELS);
  const nextState = { ...state, recentModels };
  await saveAppState(nextState, userDataDir);
  return nextState;
}
