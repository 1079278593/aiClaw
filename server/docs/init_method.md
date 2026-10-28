## 初始化

**入口**: `src/config/index.ts` - `initConfig(userDataDir?)`

- 由 CLI 命令 `start` 和 `init` 调用。
- 幂等：每次调用都会将 `templates/` 目录同步到 `$AICLAW_DATA_DIR`。
- **按文件策略**：每个模板文件的更新策略在代码中定义（`src/config/init-strategies.ts`），`templates/` 目录保持纯粹，只放模板文件。

**流程**：

1. `ensureDirectories(paths)` 在 `$AICLAW_DATA_DIR` 下创建所需目录。
2. 加载 `src/config/init-strategies.ts` 中定义的策略映射。
3. 对每个模板文件，按声明的策略执行：
   - `once` — 仅在目标文件不存在时复制。若配置了 `trackInstalled`，则首次复制后记录，之后即使文件被删除也不再恢复。
   - `always` — 模板内容与目标文件不一致时覆盖；内容一致则跳过，避免无谓地重写文件（如 `project_operation_manual.md`）。
   - `merge` — 深度合并 JSON：保留用户值，从模板追加新 key。
4. 加载并校验 `config.json`。若为首次创建，CLI 提示用户配置 API Key。

### 按文件策略

策略映射定义在 `src/config/init-strategies.ts` 中，编译后随代码发布：

```typescript
// src/config/init-strategies.ts

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
```

| 策略 | 行为 | 适用场景 |
|---|---|---|
| `once` | 仅在目标文件不存在时复制 | 知识库文件、用户会自定义的 prompt |
| `always` | 模板与目标内容不一致时覆盖，一致则跳过 | 必须和模板保持同步的系统文件 |
| `merge` | 深度合并 JSON：保留用户值，仅追加模板中的新 key | 其他 JSON 配置文件（暂未使用） |

**`merge` 策略细节**（用于 JSON 配置）：
- 仅存在于模板中的顶层 key，以默认值追加到用户配置。
- 仅存在于用户配置中的顶层 key 会被保留（绝不删除）。
- 双方都有的 key：用户值优先。嵌套对象递归合并。
- 数组（如 `models`）**不**合并 — 用户数组完全覆盖模板数组。

**`trackInstalled` 选项**：
- 仅对 `once` 策略生效。
- 首次复制后，文件路径写入 `$AICLAW_DATA_DIR/.installed_templates.json`。
- 后续 init 时，若文件在已安装记录中，即使目标路径不存在也不恢复。
- 适用场景：示例文件——新用户能看到，老用户删除后不会复活。

**路径匹配规则**：
- 模板文件相对于 `templates/` 的路径必须与 `FILE_STRATEGIES` 中的 key 精确匹配。
- 未匹配到的文件走 `DEFAULT_STRATEGY`（当前为 `once`）。

### 模板目录（`templates/`）

```text
templates/
|- .gitignore
|- .gitattributes
|- config.json
|- files/
|  |- commands.md
|  |- project_operation_manual.md
|  `- prompts/
|     |- agent_system_prompt.txt
|     `- compaction_prompt.txt
`- knowledge_base/
   |- index.md
   |- instructions.md
   `- 示例/
      |- index.md
      `- 寄生机器的悖论.md
```

同步后，`$AICLAW_DATA_DIR` 下存在相同的相对路径结构。

**Paths**: `src/config/paths.ts` - `getPaths(userDataDir?)` 返回所有路径常量；`ensureDirectories(paths)` 创建所需目录。
