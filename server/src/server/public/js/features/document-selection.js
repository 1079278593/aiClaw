const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER",
  "UL", "OL", "LI", "BLOCKQUOTE",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "PRE", "TABLE", "TR",
]);

export function getDocSelectionSummary(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

export function getLineNumberFromOffset(root, targetNode, targetOffset) {
  const offset = getPreviewTextOffset(root, targetNode, targetOffset);
  const fullText = root.innerText || root.textContent || "";
  const normalized = fullText.replace(/\r\n/g, "\n");
  const prefix = normalized.slice(0, Math.min(offset, normalized.length));
  return (prefix.match(/\n/g)?.length || 0) + 1;
}

export function getSourceLineNumberFromOffset(root, targetNode, targetOffset, edge = "start") {
  const sourceLine = getMappedSourceLine(root, targetNode, targetOffset, edge);
  return sourceLine ?? getLineNumberFromOffset(root, targetNode, targetOffset);
}

function getMappedSourceLine(root, targetNode, targetOffset, edge) {
  const directLine = getLineFromNodeOrAncestor(root, targetNode);
  if (directLine !== null) return directLine;
  if (targetNode.nodeType !== Node.ELEMENT_NODE) return null;

  const children = [...targetNode.childNodes];
  if (!children.length) return null;
  let index = edge === "end"
    ? Math.min(Math.max(targetOffset - 1, 0), children.length - 1)
    : Math.min(Math.max(targetOffset, 0), children.length - 1);
  const step = edge === "end" ? -1 : 1;
  while (index >= 0 && index < children.length) {
    const line = getLineFromNodeOrDescendant(root, children[index], edge);
    if (line !== null) return line;
    index += step;
  }
  return null;
}

function getLineFromNodeOrAncestor(root, node) {
  let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (element && root.contains(element)) {
    const value = Number.parseInt(element.getAttribute?.("data-source-line") || "", 10);
    if (Number.isInteger(value) && value > 0) return value;
    if (element === root) break;
    element = element.parentElement;
  }
  return null;
}

function getLineFromNodeOrDescendant(root, node, edge) {
  const ownLine = getLineFromNodeOrAncestor(root, node);
  if (ownLine !== null) return ownLine;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const children = [...node.childNodes];
  if (edge === "end") children.reverse();
  for (const child of children) {
    const line = getLineFromNodeOrDescendant(root, child, edge);
    if (line !== null) return line;
  }
  return null;
}

function getPreviewTextOffset(root, targetNode, targetOffset) {
  let text = "";
  let result = null;

  function maybeMark(node, offset) {
    if (result === null && node === targetNode && offset === targetOffset) result = text.length;
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || "";
      if (node === targetNode) result = text.length + Math.min(targetOffset, value.length);
      text += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (element.tagName === "BR") {
      maybeMark(node, 0);
      text += "\n";
      maybeMark(node, 1);
      return;
    }
    const isBlock = node !== root && BLOCK_TAGS.has(element.tagName);
    if (isBlock && text && !text.endsWith("\n")) text += "\n";
    if (node === targetNode) maybeMark(node, 0);
    const children = [...node.childNodes];
    children.forEach((child, index) => {
      if (node === targetNode) maybeMark(node, index);
      walk(child);
    });
    if (node === targetNode) maybeMark(node, children.length);
    if (isBlock && text && !text.endsWith("\n")) text += "\n";
  }

  walk(root);
  return result ?? text.length;
}
