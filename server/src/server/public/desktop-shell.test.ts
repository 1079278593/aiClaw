import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("./js/main.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles/workspace.css", import.meta.url), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to);
}

describe("desktop document homepage", () => {
  it("keeps the knowledge-base header and file tree as the first view", () => {
    const header = sliceBetween(html, '<div id="sidebar-header">', 'id="workspace-switch"');
    expect(header).toContain('class="sidebar-brand"');
    expect(header).toContain('id="sidebar-collapse-btn"');
    expect(header).not.toContain("workspace-people");
    const explorer = sliceBetween(html, 'id="workspace-switch"', 'id="sidebar-settings"');
    expect(explorer).toContain('id="file-explorer"');
    expect(html).toContain('id="file-root-tabs"');
    expect(html).toContain('id="file-tree" role="tree"');
    expect(html).toContain('id="people-browser" hidden');
    expect(html).toContain('id="workspace-reflections"');
    expect(html).toContain('id="reflections-browser" hidden');
    expect(html).not.toMatch(/<body[^>]*people-workspace/);
    expect(css).toContain("body.people-workspace #file-tree");
    expect(css).toContain("body.reflections-workspace #file-tree");
    expect(css).toContain("#sidebar.collapsed #workspace-switch");
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
});
