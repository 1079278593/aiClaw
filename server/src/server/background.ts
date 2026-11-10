/**
 * 后台任务骨架（plan §11）：启动跑一次 + 每 24 小时一次，不做定时器堆叠。
 * P1 只注册 `pending/_archive` 一个清理器；P2 再往里加别的。
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { getInstallRoot, getPaths, ensureDirectories } from "../config/paths.js";
import type { getLogger } from "../logger/index.js";
import { sweepPendingTtl } from "../pending/ttl.js";
import { sweepArchiveTtl } from "../pending/archive-ttl.js";
import { autoRefreshStaleDistill } from "../distill/generate.js";
import type { Config } from "../config/index.js";
import {
  createIndexWatcherManager,
  hasIndexRoots,
  type IndexWatcherManager,
} from "../index/watcher-manager.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type Logger = ReturnType<typeof getLogger>;

/** 服务可能同时承载多个 tenant，逐个扫描 `tenants/<id>/`；无 tenants/ 时退回安装根。 */
async function listTenantDirs(installRoot: string): Promise<string[]> {
  const tenantsRoot = path.join(installRoot, "tenants");
  try {
    const entries = await readdir(tenantsRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(tenantsRoot, entry.name));
    if (dirs.length) return dirs;
  } catch {
    // 老装/测试环境没有 tenants/，直接用安装根。
  }
  return [installRoot];
}

export async function runPendingTtlSweep(logger: Logger, now?: Date): Promise<void> {
  let tenantDirs: string[];
  try {
    tenantDirs = await listTenantDirs(getInstallRoot());
  } catch (error) {
    logger.warn(`pending TTL sweep skipped: ${(error as Error).message}`);
    return;
  }
  for (const tenantDir of tenantDirs) {
    try {
      await sweepPendingTtl({
        userDataDir: tenantDir,
        now,
        log: (message) => logger.info(message),
      });
    } catch (error) {
      // 失败只记日志，不影响请求。
      logger.warn(`pending TTL sweep failed for ${tenantDir}: ${(error as Error).message}`);
    }
  }
}

export async function runArchiveTtlSweep(logger: Logger, now?: Date): Promise<void> {
  let tenantDirs: string[];
  try {
    tenantDirs = await listTenantDirs(getInstallRoot());
  } catch (error) {
    logger.warn(`archive TTL sweep skipped: ${(error as Error).message}`);
    return;
  }
  for (const tenantDir of tenantDirs) {
    try {
      await sweepArchiveTtl({
        userDataDir: tenantDir,
        now,
        log: (message) => logger.info(message),
      });
    } catch (error) {
      logger.warn(`archive TTL sweep failed for ${tenantDir}: ${(error as Error).message}`);
    }
  }
}

/**
 * 启动时重算过期的蒸馏（plan_distill §6）。
 *
 * **默认关闭**（`config.autoRefreshDistill`）：后台自动调用模型会烧 token，
 * 而「摘要变了但没人让我改」很难解释给用户听。打开后也只处理少量、
 * 近期刷新过、且来源确实变动过的摘要；失败只记日志。
 */
export async function runDistillStartupRefresh(
  logger: Logger,
  config?: Config,
  now?: Date,
): Promise<void> {
  if (!config?.autoRefreshDistill) return;
  let tenantDirs: string[];
  try {
    tenantDirs = await listTenantDirs(getInstallRoot());
  } catch (error) {
    logger.warn(`distill startup refresh skipped: ${(error as Error).message}`);
    return;
  }
  for (const tenantDir of tenantDirs) {
    try {
      const result = await autoRefreshStaleDistill({
        tenantDir,
        config,
        now,
        log: (message) => logger.warn(message),
      });
      if (result.refreshed.length) {
        logger.info(`distill startup refresh: ${tenantDir} 重算 ${result.refreshed.length} 篇`);
      }
    } catch (error) {
      // 蒸馏是缓存，整轮失败也不影响别的后台任务。
      logger.warn(`distill startup refresh failed for ${tenantDir}: ${(error as Error).message}`);
    }
  }
}

/**
 * 启动清理任务与索引监听，返回停止函数。
 * 启动时异步跑一次（不阻塞 listen），之后每 24 小时一次。
 *
 * 索引监听（plan §5.3 L2）是可选的加速层：只降低 L1 的触发频率，
 * 不承担正确性——事件丢失、inotify 配额满时自动退化为 L1。
 */
export function startBackgroundTasks(logger: Logger, config?: Config): () => void {
  void runPendingTtlSweep(logger);
  void runArchiveTtlSweep(logger);
  void runDistillStartupRefresh(logger, config);
  const watchers = startIndexWatchersForTenants(logger);
  const timer = setInterval(() => {
    void runPendingTtlSweep(logger);
    void runArchiveTtlSweep(logger);
  }, ONE_DAY_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    watchers.stopAll();
  };
}

/**
 * 为每个已有 tenant 起索引监听，并跟随新出现的 tenant。
 *
 * 首次扫描与后续补扫共用一个函数：tenants/ 下出现新目录时，
 * 下一次 24 小时扫描会把它纳入（新建 tenant 本来就会由接口路径触发 L0/L1，
 * 这里只是补上「绕过 API 的外部改动」这条漏网路径）。
 */
function startIndexWatchersForTenants(logger: Logger): IndexWatcherManager {
  const manager = createIndexWatcherManager();
  const sweep = async (): Promise<void> => {
    let tenantDirs: string[];
    try {
      tenantDirs = await listTenantDirs(getInstallRoot());
    } catch (error) {
      logger.warn(`index watcher skipped: ${(error as Error).message}`);
      return;
    }
    for (const dir of tenantDirs) {
      try {
        // 升级补建：`ensureDirectories` 是幂等的，已存在的目录与内容一律不动。
        //
        // 之前只有 default 租户会在 `start` 里跑 `initConfig`，其它租户的目录
        // 停留在「建号那一刻」的版本：新版本新增的 reflections/、people/、
        // distill/、pending/ 永远不会补上，于是索引监听报 WARN、心得页空白。
        // 放在这里（而不是启动时一次性）可以顺带覆盖 24h 内新出现的租户。
        await ensureDirectories(getPaths(dir));
      } catch (error) {
        logger.warn(`tenant bootstrap failed for ${dir}: ${(error as Error).message}`);
        continue;
      }
      try {
        if (await hasIndexRoots(dir)) manager.ensure(dir);
      } catch (error) {
        logger.warn(`index watcher failed for ${dir}: ${(error as Error).message}`);
      }
    }
  };
  void sweep();
  return manager;
}

/** 当前安装根的 pending 目录（诊断用）。 */
export function pendingRootOf(userDataDir?: string): string {
  return getPaths(userDataDir).pending;
}
