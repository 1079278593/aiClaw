/**
 * Per-file initialization strategies for template files.
 *
 * Each template file declares its own update strategy.
 * Unlisted files fall back to DEFAULT_STRATEGY.
 *
 * Strategies:
 * - once:     Copy only when target does not exist.
 * - always:   Overwrite target when template content differs; skip when identical.
 * - merge:    Deep-merge JSON — keep user values, append new keys from template.
 *
 * trackInstalled (only for once): record the file after first install.
 * Subsequent inits skip it even if the user deleted it.
 */

export type InitStrategy = 'once' | 'always' | 'merge';

export interface StrategyEntry {
  strategy: InitStrategy;
  /** 仅对 once 生效。首次安装后记录，之后即使文件被删除也不再恢复。 */
  trackInstalled?: boolean;
}

export const DEFAULT_STRATEGY: InitStrategy = 'once';

// key 为相对于 templates/ 的精确路径
// 未匹配到的文件走 defaultStrategy
export const FILE_STRATEGIES: Record<string, StrategyEntry> = {
  '.gitignore':                { strategy: 'once' },
  '.gitattributes':            { strategy: 'once' },
  'config.json':               { strategy: 'once' },
  'files/commands.md':         { strategy: 'once' },
  'files/project_operation_manual.md': { strategy: 'always' },
  'files/prompts/agent_system_prompt.txt': { strategy: 'once' },
  'files/prompts/compaction_prompt.txt':   { strategy: 'once' },
  'knowledge_base/index.md':               { strategy: 'once' },
  'knowledge_base/instructions.md':        { strategy: 'once' },
  'knowledge_base/示例/index.md':            { strategy: 'once', trackInstalled: true },
  'knowledge_base/示例/寄生机器的悖论.md':    { strategy: 'once', trackInstalled: true },
};

/**
 * Resolve the strategy for a given template file.
 */
export function resolveStrategy(relPath: string): StrategyEntry {
  if (relPath in FILE_STRATEGIES) {
    return FILE_STRATEGIES[relPath];
  }
  return { strategy: DEFAULT_STRATEGY };
}
