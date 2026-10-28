/** 镜像构建时写入。本地直接启动没有这两个环境变量时显示 dev。 */
export function serverVersion(): { version: string; commit: string } {
  const version = process.env.AICLAW_BUILD?.trim() || "dev";
  const commit = process.env.AICLAW_COMMIT?.trim() || "";
  return { version, commit };
}

export function formatServerVersion(info: { version: string; commit: string } = serverVersion()): string {
  return info.commit ? `${info.version} · ${info.commit}` : info.version;
}
