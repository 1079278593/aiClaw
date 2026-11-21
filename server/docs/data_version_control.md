# 数据版本控制方案（调研与建议）

> 状态：**本文档只是调研与方案，未做任何代码或配置改动。**
> 写于 2026-11，对应代码版本：`server/src/server/services/git-sync.ts` 已实现但数据目录未初始化。

## 0. 先看现状：这套能力已经存在，只是没启用

在讨论「要不要引入版本控制」之前，必须先明确一件事：**项目里已经有 git 同步的实现**，缺的只是初始化。

| 已有物 | 位置 | 状态 |
|--------|------|------|
| git 同步服务 | `server/src/server/services/git-sync.ts` | ✅ 完整实现 status / pull(ff-only) / push(commit+push) |
| HTTP 路由 | `server/src/server/routes/git-sync.ts` | ✅ `/api/git/status`、`/api/git/pull`、`/api/git/push` |
| 前端入口 | 顶栏「同步」按钮 | ✅ 受 `state.gitSyncEnabled` 控制 |
| 租户 `.gitignore` | `server/templates/.gitignore` | ✅ `strategy: 'once'` 写入每个租户根 |
| 租户 `.gitattributes` | `server/templates/.gitattributes` | ✅ 同上 |
| 数据目录是 git 仓库 | `/Users/ming/aiclaw-data` | ❌ **`fatal: not a git repository`** |

也就是说：**功能齐了，仓库没 init。**

### 两个容易踩的前提

**① git 同步只在回环地址下可用。**

`server/src/server/http.ts`：

```typescript
const gitSyncEnabled = isLoopbackHost(host);
```

`host` 不是回环地址时，`/api/git/*` 一律 404，顶栏同步按钮也不渲染。所以：

- 本机 `server.host = 127.0.0.1` → **可用**
- NAS 上如果监听 `0.0.0.0` → **不可用**（这是安全设计：避免远端触发本地 git 操作）

**② 模板里的 `.gitignore` 是 `strategy: 'once'`，改模板不会更新已有租户。**

`server/src/config/init-strategies.ts`：

```
'.gitignore':     { strategy: 'once' },
'.gitattributes': { strategy: 'once' },
```

`once` = 只在文件不存在时写入。所以改动模板只影响**新建**租户，`ming` / `default` 需要手动同步。

当前 `templates/.gitignore` 只有三行：

```gitignore
logs/
conversation_archive/
files/app_state.json
```

**注意 `conversations/` 不在其中**——会话历史会全部进仓库。见 §4.1。

---

## 1. 文字类数据的版本控制有哪几种做法

不是互斥的，实际项目通常组合使用。按「实现成本 → 能力」排列。

### 1.1 完整 VCS：git / jj

**原理**：内容寻址存储，按行 diff，DAG 历史。

| 优点 | 代价 |
|------|------|
| 行级 diff，改一个词只存一行上下文 | 二进制文件（图片/PDF）每次改动存整个文件，仓库迅速膨胀 |
| 内容去重：相同内容只存一份 | 依赖 `git` 二进制（容器内需可用） |
| 分支、合并、`blame`、`revert` 开箱即用 | 冲突处理对非程序员不友好 |
| 生态成熟，GUI 工具多 | 频繁小提交会产生大量 commit，日志噪音 |
| 离线历史完整 | `.gitattributes` 标 `binary` 只防行尾转换，**不解决体积问题** |

**适合**：纯文本为主、需要跨设备、需要精确回滚、作者是开发者。

**对本项目**：`reflections/`、`knowledge_base/`、`people/` 全是 Markdown，是 git 的最优场景。单人使用**不会遇到合并冲突**——这是 git 最大的使用门槛，直接被绕过了。

### 1.2 快照式备份：改写前存整份副本

**原理**：覆盖前把旧文件复制到 `_archive/<时间戳>-<原名>`，保留最近 N 份。

**项目里已经有这个模式**：

- `server/src/distill/store.ts` 的 `archiveBeforeOverwrite()` —— `distill/` 覆盖/删除前归档，保留 3 份
- `server/src/pending/archive-ttl.ts` 的 `sweepArchiveTtl()` —— 90 天 TTL 清理，覆盖 `agents/**/memory/_archive`、`distill`、`people`

| 优点 | 代价 |
|------|------|
| 零外部依赖，纯文件操作 | 存储线性增长 |
| 恢复直观（拷回去即可） | 无 diff，无法知道「改了什么」 |
| 可以嵌进流程，不依赖用户手动操作 | 大文件压力明显 |

**关键是它覆盖了 git 的盲区**：git 记录的是「**我主动提交时**的状态」，而 AI 的改动发生在你没提交的时候。靠 git 兜底要求「每次 AI 改完手动 commit」——那和现在手动点「同意」没本质区别。

**项目里的缺口**：`reflections/` 和 `knowledge_base/` **没有归档**，而它们恰恰是真相源。`sweepArchiveTtl()` 的 `roots` 只有 `agents`、`distill`、`people`。

### 1.3 系统级快照：NAS Snapshot / Time Machine / ZFS

**原理**：存储层定时对共享文件夹打快照，与应用无关。

| 优点 | 代价 |
|------|------|
| 零代码 | 粒度粗（按小时/天，非按次操作） |
| 覆盖一切，含二进制与 `.git` 本身 | 无法定位到「某一次 AI 提案」 |
| 误删也能恢复 | 整目录恢复较重 |

**对本项目**：`plan_reflections_chat.md` §16 已把「需要 NAS 快照」写进部署前提。这层是兜底，不是主力。

### 1.4 数据库 + 事件日志（审计表）

**原理**：每次变更记一条记录（who / when / target / before / after / 关联提案 id），存 SQLite 或 Postgres。

| 优点 | 代价 |
|------|------|
| 可结构化查询（「这周 AI 改了几篇」） | 要写不少代码 |
| 可做 UI、可关联 `pending` 提案 | **文件系统与日志双写一致性**是经典坑 |
| 变更元数据（谁触发、哪个模型）可留 | 备份要同时覆盖 DB 和文件 |

**对本项目**：单人场景性价比低。唯一有吸引力的点是「按 pending 提案粒度查询」，但这可以用轻量方式（归档目录名里带提案 id）实现，不必上数据库。

---

## 2. 「项目内 git 是常规吗」

需要区分两件事，答案不同：

| 用途 | 行业常规 | 本项目 |
|------|----------|--------|
| **代码**版本控制 | git，绝对标准 | ✅ 已是 git 仓库 |
| **用户数据**版本控制 | 看场景；个人知识库普遍用 git | 🟡 有实现，未启用 |

个人知识库用 git 管数据是**主流做法**，不是异类：

- Obsidian 有 `obsidian-git` 插件，几乎是标配
- Logseq、Foam 社区同理
- 纯 Markdown + 单作者 = git 的理想负载

所以「项目内用 git」在**两个层面**都常规。

---

## 3. 本项目要不要 git：结论

**要，但不应只有 git。**

支持用：

- 内容几乎全是 Markdown
- 已有 `pending` + `baseHash` 并发校验，说明已经在意「改动可追溯」
- 已有 NAS + Gitea，跨设备基础设施就绪
- 单人使用，不会遇到合并冲突

反对「只用 git」：

- `conversations/` 可能很大，`_archive/` 持续累积 → 仓库膨胀
- 图片、PDF 进知识库后 git 会很痛
- git 是**提交粒度**，而想要的是**每次 AI 提案的粒度**——两者不对齐

---

## 4. 建议方案：分层组合

### 4.1 第 1 层：启用已存在的 git-sync（成本近零）

只差一次初始化：

```bash
cd /Users/ming/aiclaw-data
git init
git remote add origin <私有仓库地址>
git add -A && git commit -m "init"
git push -u origin HEAD
```

**但先处理两个隐患：**

**隐患 A：`conversations/` 没被忽略。** 会话历史增长最快、价值最低，且含大量 token 浪费。建议 `.gitignore` 增加：

```gitignore
conversations/
files/usage_temp.json
files/usage_daily.json
files/usage_total.json
```

**隐患 B：`.gitignore` 是 `once` 策略。** 改模板不会更新 `ming` / `default`，需手动同步这两个文件。

**隐患 C（需要评估）：数据量。** 先量一下再决定：

```bash
du -sh /Users/ming/aiclaw-data/tenants/*/conversations
du -sh /Users/ming/aiclaw-data/tenants/*/reflections
du -sh /Users/ming/aiclaw-data/tenants/*/knowledge_base
```

**本机实测（2026-11）**：`ming` 与 `default` 两个租户的 `conversations/`、`conversation_archive/`、`logs/` 全部为 **0 B**，`knowledge_base/` 各 16 KB。也就是说当前数据量小到 git 毫无压力——**体积不是启用 git 的障碍**（前提是别把 `conversations/` 的长期增长算进来）。

纯文本几十 MB 以内 git 完全没问题；上百 MB 且持续增长就要谨慎。规划时按「会话历史会持续增长」来预留，而不是按今天的 0 B 判断。

### 4.2 第 2 层：给真相源加 apply 前快照（核心建议）

把 `distill/store.ts` 的 `archiveBeforeOverwrite()` 模式扩展到 `pending/apply.ts`，在**落盘前**把旧内容存进归档。

收益：

- 「点同意」这件事本身变安全（可回滚），**降低确认摩擦**而不牺牲安全
- 不依赖 git，也不受「git 未初始化」影响
- 复用现成模式与 90 天 TTL 清理

配套改动：把 `reflections`、`knowledge_base` 加进 `sweepArchiveTtl()` 的 `roots`。

> 注：这一层与 git **互补而非替代**。git 需要手动 commit，快照是自动的、按操作粒度的。

### 4.3 第 3 层：NAS 快照兜底

群晖后台开定时快照即可，不改代码。覆盖 git 管不到的东西：二进制、`conversations/`、`.git` 自身。

### 4.4 不建议做的

| 方案 | 原因 |
|------|------|
| 引入 SQLite 事件日志 | 单人场景收益不抵复杂度，还要维护双写一致性 |
| 二进制文件用 git | 仓库膨胀；需要时用 `git-lfs` 或直接排除 |
| 每次对话自动 commit | 产生海量无意义提交，淹没真正有价值的历史 |
| 只做 NAS 快照 | 粒度太粗，无法定位到某次 AI 提案 |

---

## 5. 与现有设计（plan）的对应关系

| plan 中的约定 | 现状 |
|---------------|------|
| `distill/`、`agents/`、`people/` 覆盖前归档、保留 3 份 | ✅ 已实现 |
| 三类 `_archive` 90 天 TTL | ✅ `sweepArchiveTtl()` |
| §16「部署前提：需要 NAS 快照」 | 🟡 文档已写，未强制 |
| `reflections/`、`knowledge_base/` 归档 | ❌ **未实现**（本文建议项） |
| 数据目录 git 同步 | 🟡 代码已实现，未初始化 |

---

## 6. 决策记录

截至本文档编写时，用户的决定：

- **版本控制这块先不动代码**，只留本文档供后续参考
- `conversations/` 是否进仓库：**先不做决定**

后续如果推进，建议顺序：§4.1 量化数据量 → 决定 git 是否启用 → §4.2 补真相源归档。
