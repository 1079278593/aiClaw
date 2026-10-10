import { requestJson, jsonRequest } from "../api.js";

let operationActive = false;
let modalEventsInitialized = false;
let statusKnown = false;
let workingTreeDirty = false;

function updateOperationAvailability() {
  document.querySelectorAll(".git-sync-operation").forEach((button) => {
    button.disabled = operationActive || !statusKnown || (button.id === "git-sync-pull-btn" && workingTreeDirty);
  });
}

function setStatus(data) {
  const dataDir = document.getElementById("git-sync-data-dir");
  const branch = document.getElementById("git-sync-branch");
  const upstream = document.getElementById("git-sync-upstream");
  const worktree = document.getElementById("git-sync-worktree");
  if (dataDir && data.dataDir) dataDir.textContent = data.dataDir;
  if (branch) branch.textContent = data.branch || "-";
  if (upstream) upstream.textContent = data.upstream || "未设置上游";
  const changes = Number(data.changes || 0);
  statusKnown = true;
  workingTreeDirty = changes > 0;
  if (worktree) {
    worktree.className = `git-sync-state${changes ? " warning" : ""}`;
    worktree.textContent = changes ? `${changes} 项本地修改` : "干净";
  }
  updateOperationAvailability();
}

function showResult(kind, title, output, needsManualHelp) {
  const result = document.getElementById("git-sync-result");
  const resultTitle = document.getElementById("git-sync-result-title");
  const resultOutput = document.getElementById("git-sync-result-output");
  const manualNote = document.getElementById("git-sync-manual-note");
  if (!result || !resultTitle || !resultOutput || !manualNote) return;
  result.className = `git-sync-result show ${kind}`;
  resultTitle.textContent = title;
  resultOutput.textContent = output || "无输出。";
  manualNote.hidden = !needsManualHelp;
}

function setBusy(busy, action) {
  updateOperationAvailability();
  const label = document.querySelector(`#git-sync-${action}-btn .git-sync-operation-name`);
  if (label) label.textContent = busy ? `正在${action === "pull" ? "拉取" : "推送"}...` : action === "pull" ? "拉取更新" : "提交并推送";
}

async function loadStatus() {
  const { response, data } = await requestJson("/api/git/status");
  if (!response.ok) throw new Error(data.error || "无法读取 Git 状态。");
  setStatus(data);
}

export async function openGitSyncModal() {
  const modal = document.getElementById("git-sync-modal");
  if (!modal) return;
  modal.classList.add("open");
  statusKnown = false;
  updateOperationAvailability();
  document.getElementById("git-sync-result")?.classList.remove("show");
  document.getElementById("git-sync-manual-note")?.setAttribute("hidden", "");
  try {
    await loadStatus();
  } catch (error) {
    showResult("error", "无法读取同步状态", error.message || "未知错误", true);
  }
}

export function closeGitSyncModal() {
  document.getElementById("git-sync-modal")?.classList.remove("open");
}

async function runOperation(action) {
  if (operationActive || !statusKnown || (action === "pull" && workingTreeDirty)) return;
  operationActive = true;
  setBusy(true, action);
  try {
    const { response, data } = await requestJson(`/api/git/${action}`, jsonRequest("POST"));
    if (!response.ok) {
      showResult("error", action === "pull" ? "无法拉取" : "推送失败", [data.error, data.output].filter(Boolean).join("\n\n"), true);
      return;
    }
    setStatus(data.status);
    showResult("success", action === "pull" ? "拉取完成" : data.committed ? "推送完成" : "无需推送", data.output, false);
  } catch (error) {
    showResult("error", "同步失败", error.message || "网络请求失败。", true);
  } finally {
    operationActive = false;
    setBusy(false, action);
  }
}

export function initGitSync() {
  const entry = document.getElementById("git-sync-btn");
  if (entry && !entry.dataset.initialized) {
    entry.dataset.initialized = "true";
    entry.addEventListener("click", () => void openGitSyncModal());
  }

  if (modalEventsInitialized) return;
  modalEventsInitialized = true;
  document.getElementById("git-sync-pull-btn")?.addEventListener("click", () => void runOperation("pull"));
  document.getElementById("git-sync-push-btn")?.addEventListener("click", () => void runOperation("push"));
  document.getElementById("git-sync-copy-btn")?.addEventListener("click", async () => {
    const output = document.getElementById("git-sync-result-output")?.textContent || "";
    await navigator.clipboard?.writeText(output);
  });
}
