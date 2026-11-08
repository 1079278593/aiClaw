import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("./js/main.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("./js/features/chat.js", import.meta.url), "utf8");
const reflections = readFileSync(new URL("./js/features/reflections.js", import.meta.url), "utf8");
const dom = readFileSync(new URL("./js/dom.js", import.meta.url), "utf8");
const features = {
  pending: readFileSync(new URL("./js/features/pending.js", import.meta.url), "utf8"),
};

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to);
}

describe("desktop document homepage", () => {
  it("keeps the knowledge-base header and file tree as the first view", () => {
    const header = sliceBetween(html, '<div id="sidebar-header">', 'id="panel-switch"');
    expect(header).toContain('class="sidebar-brand"');
    expect(header).toContain('id="sidebar-collapse-btn"');
    expect(header).not.toContain("panel-people");
    const explorer = sliceBetween(html, 'id="panel-switch"', 'id="sidebar-settings"');
    expect(explorer).toContain('id="file-explorer"');
    expect(html).toContain('id="file-root-tabs"');
    expect(html).toContain('id="file-tree" role="tree"');
    expect(html).toContain('id="people-browser" hidden');
    expect(html).toContain('id="panel-reflections"');
    expect(html).toContain('id="reflections-browser" hidden');
    expect(html).not.toMatch(/<body[^>]*people-panel/);
    expect(css).toContain("body.people-panel #file-tree");
    expect(css).toContain("body.reflections-panel #file-tree");
    expect(css).toContain("#sidebar.collapsed #panel-switch");
  });

  it("does not reuse the word workspace for panel switching", () => {
    // 「文档 / 人物 / 心得」只是左栏面板切换，与会话无关。
    // 曾经的 workspace 命名让两侧都误以为是会话工作区，禁止回潮。
    for (const source of [html, main, css]) {
      expect(source).not.toContain("workspace-switch");
      expect(source).not.toContain("people-workspace");
      expect(source).not.toContain("reflections-workspace");
      expect(source).not.toContain("data-workspace-mode");
    }
  });

  it("still boots the explorer, sessions, and socket after the access gate", () => {
    expect(main).toContain('import { ensureAccessTokenGate, fetchHealth, setAccessToken } from "./access-token.js"');
    const boot = main.slice(main.indexOf("async function boot"));
    const health = boot.indexOf("await fetchHealth()");
    const gate = boot.indexOf("ensureAccessTokenGate");
    const explorer = boot.indexOf("documents.initExplorer()");
    const sessions = boot.indexOf("actions.loadSessions()");
    const connect = boot.indexOf("socket.connect()");
    expect(health).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(health);
    expect(explorer).toBeGreaterThan(gate);
    expect(sessions).toBeGreaterThan(explorer);
    expect(connect).toBeGreaterThan(sessions);
  });

  it("exposes the pending proposals entry inside the reflections panel", () => {
    // 「待应用」挂在心得面板底部，而不是另开一个左栏 tab（§10.1）。
    const browser = sliceBetween(html, 'id="reflections-browser"', 'id="sidebar-settings"');
    expect(browser).toContain('id="pending-open"');
    expect(browser).toContain('id="pending-badge"');
    expect(html).toContain('id="pending-panel"');
    expect(html).toContain('id="pending-list"');
    expect(html).toContain('id="pending-detail"');
    expect(html).not.toContain("panel-pending");

    expect(main).toContain('import { createPendingFeature } from "./features/pending.js"');
    expect(main).toContain("pending.bind()");
    expect(css).toContain(".reflections-chat-entry");
    expect(css).toContain(".reflections-chat-badge");
    expect(css).toContain(".pending-diff-col pre");
    // 批量应用入口与逐条结果（§12.2）：冲突必须能被用户看见。
    expect(features.pending).toContain("apply-all");
    expect(features.pending).toContain("pending-apply-all");
    expect(css).toContain(".pending-batch-row.warn");
  });

  it("exposes the chat entry inside the reflections panel and reuses the single chat panel", () => {
    // plan §10.1：心得面板要有「对话」入口，且右栏 `#chat-panel` 全局只有一个，切面板不换会话。
    const browser = sliceBetween(html, 'id="reflections-browser"', 'id="sidebar-settings"');
    expect(browser).toContain('id="reflections-chat-open"');
    // 右栏 `#chat-panel` 只在 dom.js 渲染一次：切面板不新建第二个聊天面板。
    expect(dom.match(/id="chat-panel"/g)).toHaveLength(1);
    expect(reflections).toContain('getElementById("reflections-chat-open")');
    expect(chat).toContain("function focusChat");
  });
});
