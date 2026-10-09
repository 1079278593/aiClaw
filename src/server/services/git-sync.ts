import { spawn } from "node:child_process";
import { BRAND_NAME } from "../../brand.js";
import { getPaths } from "../../config/paths.js";

const GIT_TIMEOUT_MS = 30_000;

export type GitSyncStatus = {
  branch: string;
  upstream: string | null;
  changes: number;
};

export type GitSyncResult = {
  status: GitSyncStatus;
  output: string;
  committed: boolean;
};

export class GitSyncError extends Error {
  constructor(
    message: string,
    public readonly code: "busy" | "not_repository" | "working_tree_dirty" | "git_error",
    public readonly output = "",
  ) {
    super(message);
  }
}

let operationActive = false;

type GitCommandResult = {
  exitCode: number;
  output: string;
};

function formatOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

async function runGit(dataDir: string, args: string[], allowedExitCodes = [0]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: dataDir,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GitSyncError(`无法执行 Git：${error.message}`, "git_error"));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const output = formatOutput(stdout, stderr);
      if (timedOut) {
        reject(new GitSyncError("Git 操作超时，已停止执行。", "git_error", output));
        return;
      }
      if (exitCode === null || !allowedExitCodes.includes(exitCode)) {
        reject(new GitSyncError("Git 命令执行失败。", "git_error", output));
        return;
      }
      resolve({ exitCode, output });
    });
  });
}

async function ensureRepository(dataDir: string): Promise<void> {
  try {
    const result = await runGit(dataDir, ["rev-parse", "--is-inside-work-tree"]);
    if (result.output !== "true") throw new Error("not a work tree");
  } catch (error) {
    if (error instanceof GitSyncError) {
      throw new GitSyncError("数据目录不是 Git 工作树，请先在该目录初始化 Git 仓库。", "not_repository", error.output);
    }
    throw error;
  }
}

function getCommitMessage(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${BRAND_NAME} sync: ${timestamp}`;
}

async function getStatusForDirectory(dataDir: string): Promise<GitSyncStatus> {
  await ensureRepository(dataDir);
  const [branchResult, upstreamResult, workTreeResult] = await Promise.all([
    runGit(dataDir, ["branch", "--show-current"]),
    runGit(dataDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], [0, 128]),
    runGit(dataDir, ["status", "--porcelain=v1"]),
  ]);
  return {
    branch: branchResult.output || "HEAD (detached)",
    upstream: upstreamResult.exitCode === 0 ? upstreamResult.output : null,
    changes: workTreeResult.output ? workTreeResult.output.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (operationActive) throw new GitSyncError("已有同步操作正在进行，请等待其完成。", "busy");
  operationActive = true;
  try {
    return await operation();
  } finally {
    operationActive = false;
  }
}

export async function getGitSyncStatus(dataDir = getPaths().base): Promise<GitSyncStatus> {
  return getStatusForDirectory(dataDir);
}

export async function pullGitSync(dataDir = getPaths().base): Promise<GitSyncResult> {
  return runExclusive(async () => {
    const status = await getStatusForDirectory(dataDir);
    if (status.changes > 0) {
      throw new GitSyncError("工作区存在未提交的修改，无法拉取。请先推送或手动处理。", "working_tree_dirty");
    }
    const result = await runGit(dataDir, ["pull", "--ff-only"]);
    return { status: await getStatusForDirectory(dataDir), output: result.output || "已是最新状态。", committed: false };
  });
}

export async function pushGitSync(dataDir = getPaths().base): Promise<GitSyncResult> {
  return runExclusive(async () => {
    await ensureRepository(dataDir);
    await runGit(dataDir, ["add", "-A"]);
    const staged = await runGit(dataDir, ["diff", "--cached", "--quiet"], [0, 1]);
    if (staged.exitCode === 0) {
      return { status: await getStatusForDirectory(dataDir), output: "没有需要推送的变更。", committed: false };
    }

    const commit = await runGit(dataDir, ["commit", "-m", getCommitMessage()]);
    try {
      const push = await runGit(dataDir, ["push"]);
      return {
        status: await getStatusForDirectory(dataDir),
        output: formatOutput(commit.output, push.output),
        committed: true,
      };
    } catch (error) {
      if (error instanceof GitSyncError) {
        throw new GitSyncError("已创建本地提交，但推送失败。请手动处理后重试。", "git_error", formatOutput(commit.output, error.output));
      }
      throw error;
    }
  });
}
