import { escHtml } from "./format.js";

export function renderMarkdown(text, imageBase = "") {
  const blocks = [];
  const originalSource = String(text || "").replace(/\r\n/g, "\n");
  let source = originalSource;
  source = source.replace(/```([\s\S]*?)```/g, (match, code, offset) => {
    const key = `\u0000CODE${blocks.length}\u0000`;
    const renderedCode = code.replace(/^\n|\n$/g, "");
    const fenceLine = originalSource.slice(0, offset).split("\n").length;
    const firstCodeLine = fenceLine + (code.startsWith("\n") ? 1 : 0);
    const codeHtml = renderedCode.split("\n").map((line, index) =>
      `<span data-source-line="${firstCodeLine + index}">${escHtml(line)}</span>`,
    ).join("\n");
    blocks.push(`<pre><code>${codeHtml}</code></pre>`);
    const preservedNewlines = "\n".repeat((match.match(/\n/g) || []).length);
    return `${key}${preservedNewlines}`;
  });

  const lines = source.split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let inMathBlock = false;
  let mathBlockLines = [];
  let mathBlockStartLine = 0;

  const renderInline = (value) => {
    const codes = [];
    let result = escHtml(value);
    result = result.replace(/`([^`]+)`/g, (_, code) => {
      const key = `\u0000INLINE${codes.length}\u0000`;
      codes.push(`<code>${code}</code>`);
      return key;
    });
    result = result
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
        if (/^https?:\/\//.test(url)) return `<img src="${url}" alt="${alt}" loading="lazy">`;
        const resolved = !url.startsWith("/") && imageBase ? imageBase + url : url;
        return `<img src="/api/image?path=${encodeURIComponent(resolved)}" alt="${alt}" loading="lazy">`;
      })
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return result.replace(/\u0000INLINE(\d+)\u0000/g, (_, index) => codes[Number(index)] || "");
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map((item) => `<span data-source-line="${item.line}">${renderInline(item.text)}</span>`).join(" ")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const startAttr = list.type === "ol" && Number.isInteger(list.start) ? ` start="${list.start}"` : "";
    html.push(`<${list.type}${startAttr}>${list.items.map((item) => `<li data-source-line="${item.line}">${renderInline(item.text)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map((item) => `<p data-source-line="${item.line}">${renderInline(item.text)}</p>`).join("")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    // Keep multiline $$ math blocks as a single text node so that
    // KaTeX's renderMathInElement can find matching delimiter pairs.
    if (trimmed === "$$") {
      if (!inMathBlock) {
        flushAll();
        inMathBlock = true;
        mathBlockLines = [trimmed];
        mathBlockStartLine = i + 1;
      } else {
        mathBlockLines.push(trimmed);
        inMathBlock = false;
        html.push(`<p><span data-source-line="${mathBlockStartLine}">${renderInline(mathBlockLines.join("\n"))}</span></p>`);
        mathBlockLines = [];
      }
      continue;
    }
    if (inMathBlock) {
      mathBlockLines.push(trimmed);
      continue;
    }
    if (/^\u0000CODE\d+\u0000$/.test(trimmed)) {
      flushAll();
      html.push(trimmed);
      continue;
    }
    if (/^\|(.+)\|$/.test(trimmed) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flushAll();
      const headerLine = i + 1;
      const headers = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && /^\|(.+)\|$/.test(lines[i + 1].trim())) {
        i += 1;
        rows.push({ line: i + 1, cells: lines[i].trim().slice(1, -1).split("|").map((cell) => cell.trim()) });
      }
      html.push(`<table><thead><tr>${headers.map((cell) => `<th data-source-line="${headerLine}">${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.cells.map((cell) => `<td data-source-line="${row.line}">${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushAll();
      html.push(`<h${heading[1].length} data-source-line="${i + 1}">${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      flushAll();
      html.push(`<hr data-source-line="${i + 1}">`);
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push({ line: i + 1, text: quoteMatch[1] });
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = unordered ? "ul" : "ol";
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [], start: ordered ? Number(ordered[1]) : undefined };
      list.items.push({ line: i + 1, text: unordered ? unordered[1] : ordered[2] });
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push({ line: i + 1, text: trimmed });
  }
  // Flush any unclosed math block (e.g. cancelled mid-formula)
  if (inMathBlock && mathBlockLines.length) {
    html.push(`<p><span data-source-line="${mathBlockStartLine}">${renderInline(mathBlockLines.join("\n"))}</span></p>`);
  }
  flushAll();
  return html.join("").replace(/\u0000CODE(\d+)\u0000/g, (_, index) => blocks[Number(index)] || "");
}

export function renderContent(element, text, imageBase = "") {
  element.innerHTML = renderMarkdown(String(text || ""), imageBase);
  if (typeof globalThis.renderMathInElement === "function") {
    globalThis.renderMathInElement(element, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
    });
  }
}
