/**
 * L2 索引加速：`fs.watch` + debounce（plan §5.3）。
 *
 * 三条硬性约定，写错任何一条都会变成「正确性依赖文件系统事件」：
 *
 * 1. **事件只当提示**。收到事件后不是「把这一行加进索引」，而是对该目录
 *    重新 `readdir` 并整层重算 —— 事件可能重复、丢失、甚至指向不存在的路径。
 * 2. **不得作为正确性来源**。watcher 失效（Linux inotify 配额满、Docker bind
 *    mount 行为差异、`fs.watch` 抛错）时静默退化为 L1，不向用户报错。
 * 3. **写入必须走 `IndexWriter`**。这里只决定「哪些目录要重算」，
 *    真正写盘仍由 `calibrateDirs(..., writer, "calibrate")` 完成，
 *    否则 §13.2 第 29 条的 stub 测试会假通过。
 */

import { statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { logger } from "../logger/index.js";
import {
  calibrateDirs,
  INDEX_FILENAME,
  isAssetsDirName,
  isSystemMetaFile,
  listChildEntries,
} from "./indexer.js";
import type { IndexWriter } from "./indexer.js";

/** debounce 窗口（plan §5.3 定 300ms）。 */
export const WATCH_DEBOUNCE_MS = 300;export type WatcherOptions = {
  /** 要监听的根目录（通常是 `reflections/` 与 `knowledge_base/`）。 */
  roots: string[];
  writer: IndexWriter;
  baseDir: string;
  debounceMs?: number;
  /** 用于测试注入；默认 `node:fs` 的 `watch`。 */
  watchImpl?: typeof watch;
};

export type IndexWatcher = {
  /** 停止监听并清掉待处理的 debounce。 */
  close(): void;
  /** 测试用：等待当前排队的校准完成。 */
  flush(): Promise<void>;
  /** 已注册的根目录。 */
  readonly roots: string[];
};

/**
 * 判断一个路径变化是否值得重算索引。
 *
 * `_index.md` 自身的变化必须忽略：否则「写入索引 → 触发事件 → 再写索引」
 * 会形成自激循环（虽然内容相同会早退，但每条事件都白跑一次 readdir）。
 */
export function shouldReactTo(fileName: string): boolean {
  if (!fileName) return true; // 某些平台事件不带 filename，保守重算
  if (fileName === INDEX_FILENAME) return false;
  if (isSystemMetaFile(fileName)) return false;
  if (isAssetsDirName(fileName)) return false;
  if (fileName.startsWith(".")) return false;
  return true;
}

/**
 * 启动索引监听。
 *
 * 递归监听每个根，把所有事件按目录归并、debounce 后统一交给 `calibrateDirs`。
 * 任何一步失败都只记日志——**watcher 是可选加速，不能影响服务可用性**。
 */
export function startIndexWatcher(options: WatcherOptions): IndexWatcher {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const watchImpl = options.watchImpl ?? watch;
  const pending = new Map<string, NodeJS.Timeout>();
  const inflight = new Set<Promise<void>>();
  const watchers: FSWatcher[] = [];

  /** 把一个目录排进 debounce 队列；同目录重复事件只保留最后一次。 */
  function schedule(dir: string): void {
    const existing = pending.get(dir);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(dir);
      const task = calibrateDirs([dir], options.writer, {
        baseDir: options.baseDir,
        reason: "calibrate",
      })
        .then((result) => {
          if (!result.indexSynced) {
            // 索引写失败不算 watcher 的错：L1 下次照样会修。
            logger.debug(`index watcher: sync failed for ${dir}`);
          }
        })
        .catch((error: unknown) => {
          logger.debug(`index watcher: calibrate failed for ${dir}: ${(error as Error).message}`);
        })
        .finally(() => {
          inflight.delete(task);
        });
      inflight.add(task);
    }, debounceMs);
    timer.unref?.();
    pending.set(dir, timer);
  }

  for (const root of options.roots) {
    try {
      // 目录不存在就别注册监听。
      //
      // `hasIndexRoots` 只看「任一 root 存在」，于是一个只有 knowledge_base、
      // 没有 reflections 的租户（比如空壳账号）也会走到这里，
      // `watch()` 直接 ENOENT，日志里每次启动都刷一条 WARN。
      // 这不是异常：目录本来就可以不存在，等它被创建后由 L1 校准/下次扫描接管。
      const stats = statSync(root, { throwIfNoEntry: false });
      if (!stats?.isDirectory()) {
        logger.debug(`index watcher skipped for missing root: ${root}`);
        continue;
      }
      const watcher = watchImpl(root, { recursive: true }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : String(filename ?? "");
        if (!shouldReactTo(name)) return;
        // 事件里的 filename 是相对 root 的路径；取它所在目录作为要重算的层。
        const rel = name.replaceAll("\\", "/");
        const absolute = rel ? path.resolve(root, rel) : root;
        // 以「这个路径的父目录」为重算目标：新增/删除只影响父层。
        // 若是目录自身事件，父层同样需要重算（目录名可能变了）。
        const targetDir = path.dirname(absolute);
        // 但父目录可能不在索引根内（例如 root 的上一级），退回到 root。
        const inRoots = options.roots.some(
          (candidate) => targetDir === candidate || targetDir.startsWith(candidate + path.sep),
        );
        schedule(inRoots ? targetDir : root);
      });
      watcher.on("error", (error) => {
        // inotify 配额、挂载方式不支持递归等：静默退化，L1 仍然兜底。
        logger.warn(`index watcher disabled for ${root}: ${(error as Error).message}`);
      });
      watchers.push(watcher);
    } catch (error) {
      logger.warn(`index watcher unavailable for ${root}: ${(error as Error).message}`);
    }
  }

  return {
    roots: [...options.roots],
    close() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // 已关闭或平台不支持，忽略。
        }
      }
      watchers.length = 0;
    },
    async flush() {
      for (const timer of pending.values()) clearTimeout(timer);
      const dirs = [...pending.keys()];
      pending.clear();
      await Promise.allSettled(dirs.map((dir) => calibrateDirs([dir], options.writer, {
        baseDir: options.baseDir,
        reason: "calibrate",
      })));
      await Promise.allSettled([...inflight]);
    },
  };
}
