/**
 * 多租户索引监听（plan §5.3 L2）。
 *
 * 服务同时承载多个 tenant，每个 tenant 有独立的 `reflections/` 与
 * `knowledge_base/`。这里为每个 tenant 起一组 watcher，并按需增删。
 *
 * 与 `background.ts` 的分工：那个模块管「定时清理」，这个管「文件事件」。
 * 两者都是可选加速，失败只记日志。
 */

import path from "node:path";
import { getPaths } from "../config/paths.js";
import { createIndexWriter } from "./indexer.js";
import { startIndexWatcher, type IndexWatcher } from "./watcher.js";
import { logger } from "../logger/index.js";

export type TenantWatchers = {
  stop(): void;
  readonly baseDir: string;
};

export type IndexWatcherManager = {
  /** 为一个 tenant 启动监听；重复调用同一个 baseDir 是幂等的。 */
  ensure(baseDir: string): TenantWatchers;
  /** 停止全部监听。 */
  stopAll(): void;
  /** 已监听的 tenant 目录。 */
  readonly active: string[];
};

/**
 * 创建 watcher 管理器。
 *
 * 每个 tenant 各用一个 `IndexWriter`，其 `baseDir` 固定为该 tenant ——
 * 不能共用默认实例（默认实例按请求作用域解析路径，后台任务没有请求作用域）。
 */
export function createIndexWatcherManager(): IndexWatcherManager {
  const registry = new Map<string, { watcher: IndexWatcher; handle: TenantWatchers }>();

  function ensure(baseDir: string): TenantWatchers {
    const abs = path.resolve(baseDir);
    const existing = registry.get(abs);
    if (existing) return existing.handle;

    const writer = createIndexWriter({ baseDir: abs });
    const watcher = startIndexWatcher({
      roots: [path.join(abs, "reflections"), path.join(abs, "knowledge_base")],
      writer,
      baseDir: abs,
    });

    const handle: TenantWatchers = {
      baseDir: abs,
      stop() {
        watcher.close();
        registry.delete(abs);
      },
    };
    registry.set(abs, { watcher, handle });
    logger.debug(`index watcher started for ${abs}`);
    return handle;
  }

  return {
    ensure,
    stopAll() {
      for (const entry of registry.values()) entry.watcher.close();
      registry.clear();
    },
    get active() {
      return [...registry.keys()];
    },
  };
}

/** 一个 tenant 是否值得监听：至少有一个索引根存在。 */
export async function hasIndexRoots(baseDir: string): Promise<boolean> {
  const paths = getPaths(baseDir);
  const { stat } = await import("node:fs/promises");
  for (const root of [paths.reflections, paths.knowledgeBase]) {
    const ok = await stat(root).then((info) => info.isDirectory(), () => false);
    if (ok) return true;
  }
  return false;
}
