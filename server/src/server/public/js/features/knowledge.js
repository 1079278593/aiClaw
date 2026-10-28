import { requestJson } from "../api.js";
import { escHtml } from "../format.js";

function renderKnowledgeFiles(files, expanded) {
  const visibleFiles = expanded ? files : files.slice(0, 5);
  if (!visibleFiles.length) return '<div class="knowledge-file">暂无文件</div>';
  return visibleFiles.map((file) => `<div class="knowledge-file">${escHtml(file)}</div>`).join("");
}

function renderKnowledgeCard(base, index) {
  const files = Array.isArray(base.files) ? base.files : [];
  const collapsed = files.length > 5;
  const visibleFiles = collapsed ? files.slice(0, 5) : files;
  return `
    <section class="knowledge-card" data-index="${index}" data-expanded="false" data-files="${escHtml(JSON.stringify(files))}">
      <div class="knowledge-title">${escHtml(base.name || "")}</div>
      ${base.description ? `<div class="knowledge-desc">${escHtml(base.description)}</div>` : ""}
      <div class="knowledge-files">${renderKnowledgeFiles(visibleFiles, true)}</div>
      ${collapsed ? `<button class="knowledge-toggle">展开查看全部 ${files.length} 个文件 ▼</button>` : ""}
    </section>
  `;
}

export async function openKnowledgeModal() {
  const modal = document.getElementById("knowledge-modal");
  const empty = document.getElementById("knowledge-empty");
  const list = document.getElementById("knowledge-list");
  showEmptyLoading(empty);
  list.innerHTML = "";
  modal.classList.add("open");
  try {
    const { data } = await requestJson("/api/knowledge");
    const bases = Array.isArray(data.bases) ? data.bases : [];
    if (!bases.length) {
      showEmptyNoData(empty, "暂无知识库", "在数据目录中配置知识库即可使用");
      return;
    }
    empty.style.display = "none";
    list.innerHTML = bases.map(renderKnowledgeCard).join("");
    list.querySelectorAll(".knowledge-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".knowledge-card");
        const expanded = card.dataset.expanded === "true";
        card.dataset.expanded = expanded ? "false" : "true";
        const files = JSON.parse(card.dataset.files || "[]");
        card.querySelector(".knowledge-files").innerHTML = renderKnowledgeFiles(files, !expanded);
        button.textContent = expanded ? `展开查看全部 ${files.length} 个文件 ▼` : "收起 ▲";
      });
    });
  } catch (error) {
    showEmptyNoData(empty, "加载失败", error?.message || "未知错误");
  }
}

function showEmptyLoading(el) {
  if (!el) return;
  el.style.display = "block";
  el.innerHTML = '<div class="empty-state-icon"><i data-lucide="loader-circle"></i></div><p class="empty-state-title">加载中...</p>';
  window.lucide?.createIcons();
}

function showEmptyNoData(el, title, copy) {
  if (!el) return;
  el.style.display = "block";
  el.innerHTML = `<div class="empty-state-icon"><i data-lucide="book-open"></i></div><p class="empty-state-title">${title}</p><p class="empty-state-copy">${copy}</p>`;
  window.lucide?.createIcons();
}

export function closeKnowledgeModal() {
  document.getElementById("knowledge-modal").classList.remove("open");
}
