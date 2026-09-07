import { describe, expect, it } from "vitest";
import { htmlToReadableText } from "./html.js";
import {
  formatTriliumRef,
  isTriliumBrowserPath,
  isTriliumEnabled,
  parseTriliumNoteId,
  triliumChildBrowserPath,
  triliumNoteIdFromBrowserPath,
} from "./paths.js";

describe("trilium html", () => {
  it("flattens text notes into readable lines", () => {
    const html = "<p>你好</p><div>第二段</div><br><p>第三段 &amp; 符号</p>";
    expect(htmlToReadableText(html)).toBe("你好\n\n第二段\n\n第三段 & 符号");
  });

  it("strips scripts and keeps image alt text", () => {
    const html = '<script>alert(1)</script><p>正文</p><img alt="示意图">';
    expect(htmlToReadableText(html)).toContain("正文");
    expect(htmlToReadableText(html)).toContain("[图片: 示意图]");
    expect(htmlToReadableText(html)).not.toContain("alert");
  });
});

describe("trilium paths", () => {
  it("parses browser paths and refs", () => {
    expect(isTriliumEnabled(true, " token ")).toBe(true);
    expect(isTriliumEnabled(true, "")).toBe(false);
    expect(isTriliumBrowserPath("trilium")).toBe(true);
    expect(isTriliumBrowserPath("trilium/abc")).toBe(true);
    expect(isTriliumBrowserPath("inputs/a.md")).toBe(false);
    expect(triliumNoteIdFromBrowserPath("trilium")).toBeUndefined();
    expect(triliumNoteIdFromBrowserPath("trilium/parent/child")).toBe("child");
    expect(triliumChildBrowserPath("trilium", "abc")).toBe("trilium/abc");
    expect(parseTriliumNoteId("trilium:abc")).toBe("abc");
    expect(parseTriliumNoteId("trilium/parent/abc")).toBe("abc");
    expect(parseTriliumNoteId("abc")).toBe("abc");
    expect(formatTriliumRef("abc")).toBe("trilium:abc");
  });
});
