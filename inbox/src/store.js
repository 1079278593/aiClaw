import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError, InboxPathError } from "./errors.js";
import { getChatsRoot, resolveThreadDir, sanitizeThreadId, timestampSlug } from "./paths.js";

const THREAD_META = "_thread.json";

/**
 * @typedef {{ title: string, members: string[], kind: "dm" | "group", createdAt?: string, updatedAt?: string }} ThreadMeta
 */

export class ChatStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.chatsRoot = getChatsRoot(dataDir);
  }

  async ensureRoot() {
    await fs.mkdir(this.chatsRoot, { recursive: true });
  }

  async listThreads() {
    await this.ensureRoot();
    const entries = await fs.readdir(this.chatsRoot, { withFileTypes: true });
    const threads = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const meta = await this.readMeta(entry.name);
        threads.push({ id: entry.name, ...meta });
      } catch {
        threads.push({
          id: entry.name,
          title: entry.name,
          members: ["我"],
          kind: "dm",
        });
      }
    }
    threads.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    return threads;
  }

  async readMeta(threadId) {
    const { dir } = resolveThreadDir(this.chatsRoot, threadId);
    const raw = await fs.readFile(path.join(dir, THREAD_META), "utf-8");
    return JSON.parse(raw);
  }

  async writeMeta(threadId, meta) {
    const { id, dir } = resolveThreadDir(this.chatsRoot, threadId);
    await fs.mkdir(dir, { recursive: true });
    const payload = {
      title: meta.title || id,
      members: normalizeMembers(meta.members),
      kind: meta.kind === "group" ? "group" : "dm",
      createdAt: meta.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, THREAD_META), JSON.stringify(payload, null, 2) + "\n", "utf-8");
    return { id, ...payload };
  }

  async createThread({ title, members, kind }) {
    const id = sanitizeThreadId(title);
    const { dir } = resolveThreadDir(this.chatsRoot, id);
    try {
      await fs.access(path.join(dir, THREAD_META));
      throw new InboxPathError(`会话已存在：${id}`);
    } catch (err) {
      if (err instanceof InboxPathError) throw err;
    }
    const memberList = normalizeMembers(members?.length ? members : kind === "group" ? ["我"] : ["我", id]);
    return this.writeMeta(id, {
      title: id,
      members: memberList,
      kind: kind === "group" ? "group" : "dm",
      createdAt: new Date().toISOString(),
    });
  }

  async updateThread(threadId, patch) {
    const existing = await this.readMeta(threadId).catch(() => {
      throw new NotFoundError(`会话不存在：${threadId}`);
    });
    return this.writeMeta(threadId, {
      ...existing,
      title: patch.title ?? existing.title,
      members: patch.members ?? existing.members,
      kind: patch.kind ?? existing.kind,
      createdAt: existing.createdAt,
    });
  }

  async assertThread(threadId) {
    const { id, dir } = resolveThreadDir(this.chatsRoot, threadId);
    try {
      await fs.access(dir);
    } catch {
      throw new NotFoundError(`会话不存在：${id}`);
    }
    let meta;
    try {
      meta = await this.readMeta(id);
    } catch {
      meta = { title: id, members: ["我", id], kind: "dm" };
      await this.writeMeta(id, meta);
      meta = await this.readMeta(id);
    }
    return { id, dir, meta };
  }

  async addTextEntry({ thread, speaker, text }) {
    const body = String(text ?? "").trim();
    if (!body) throw new InboxPathError("正文不能为空");
    const { id, dir, meta } = await this.assertThread(thread);
    const who = String(speaker ?? "").trim();
    if (!who) throw new InboxPathError("说话人不能为空");
    if (!meta.members.includes(who)) {
      meta.members = normalizeMembers([...meta.members, who]);
      await this.writeMeta(id, meta);
    }
    const stamp = timestampSlug();
    const fileName = `${stamp}.md`;
    const content =
      `---\n` +
      `speaker: ${yamlEscape(who)}\n` +
      `time: ${new Date().toISOString()}\n` +
      `thread: ${yamlEscape(id)}\n` +
      `---\n\n` +
      `${body}\n`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, content, "utf-8");
    return { thread: id, speaker: who, path: `inputs/chats/${id}/${fileName}`, fileName };
  }

  async addImageEntry({ thread, speaker, buffer, originalName, mimeType }) {
    const { id, dir, meta } = await this.assertThread(thread);
    const who = String(speaker ?? "").trim();
    if (!who) throw new InboxPathError("说话人不能为空");
    if (!meta.members.includes(who)) {
      meta.members = normalizeMembers([...meta.members, who]);
      await this.writeMeta(id, meta);
    }
    const ext = extFromUpload(originalName, mimeType);
    const stamp = timestampSlug();
    const safeSpeaker = who.replace(/[\\/]/g, "_");
    const imageName = `${stamp}__${safeSpeaker}${ext}`;
    const noteName = `${stamp}__${safeSpeaker}.md`;
    await fs.writeFile(path.join(dir, imageName), buffer);
    const note =
      `---\n` +
      `speaker: ${yamlEscape(who)}\n` +
      `time: ${new Date().toISOString()}\n` +
      `thread: ${yamlEscape(id)}\n` +
      `image: ${imageName}\n` +
      `---\n\n` +
      `![${safeSpeaker}](${imageName})\n`;
    await fs.writeFile(path.join(dir, noteName), note, "utf-8");
    return {
      thread: id,
      speaker: who,
      path: `inputs/chats/${id}/${imageName}`,
      notePath: `inputs/chats/${id}/${noteName}`,
      fileName: imageName,
    };
  }
}

function normalizeMembers(members) {
  const list = (Array.isArray(members) ? members : [])
    .map((m) => String(m).trim())
    .filter(Boolean);
  if (!list.includes("我")) list.unshift("我");
  return [...new Set(list)];
}

function yamlEscape(value) {
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || value.includes("\n") || value.includes('"')) {
    return JSON.stringify(value);
  }
  return value;
}

function extFromUpload(name, mime) {
  const fromName = path.extname(name || "").toLowerCase();
  if (fromName && fromName.length <= 8) return fromName;
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
  };
  return map[mime] || ".jpg";
}
