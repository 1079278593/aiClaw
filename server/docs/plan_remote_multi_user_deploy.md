# 外网访问、多账号与 NAS 部署 — 实施计划

> 目标：在 **不丢失现有功能** 的前提下，支持多租户数据隔离、两类 Token 分工清晰；**功能在本地开发并验证**，最后按 Quant 风格打包部署到 NAS + frp。  
> 参考部署形态：[Quant/deploy](file:///Users/ming/Documents/Gitea/Quant/deploy)（Mac 构建镜像 → 导出 → NAS Docker 项目 → 验收）。

---

## 0. 结论先行

| 问题 | 答案 |
|------|------|
| 先本地做完再部署，发布是否 mainly 打包？ | **是**。业务逻辑、鉴权、租户路径、测试在本地通过后，NAS 侧主要是 **镜像/compose/数据卷/frp 域名**，与 Quant 同思路。 |
| 「平台」指什么？ | **LLM Provider**（`zai` / `dashscope` / `deepseek` 及后续 OpenAI 兼容），密钥在 **租户 `config.json`**，服务端调用，**不下发明文**（与现 `/api/config` 一致，只返回 models）。 |
| 账号 Token？ | **租户访问令牌**（AiClaw Access Token）：随机、服务端只存 **hash**，客户端 Bearer / 未来 WS 首帧；与 LLM API Key **严格分离**。 |

---

## 1. 两类 Token（架构定稿）

### 1.1 租户访问令牌（Account / Access Token）

- **用途**：证明「是哪个用户在使用 aiClaw API / WebSocket」。
- **形态**：高熵随机串（如 `openssl rand -hex 32`），**仅创建时明文展示一次**。
- **存储**：`$AICLAW_DATA_DIR/auth/users.json`（或 SQLite，用户 &lt;50 时 JSON 足够）  
  `{ "id": "ming", "tokenHash": "<sha256>", "label": "...", "createdAt", "disabled": false }`
- **传输**：**仅 HTTPS** 下 `Authorization: Bearer <token>`。WebSocket **必须首帧 auth**（见 Phase 2），URL 不带 token；query `access_token` 只作一版兼容，随后删除。
- **管理**：CLI `aiclaw user create|revoke|rotate|list`（NAS 上 SSH 或本地），**不做**公网自助注册（避免扫端口刷库）。

### 1.2 LLM Provider 凭证（AI Token / API Key）

- **用途**：服务端请求 DeepSeek、百炼、智谱等。
- **存储**：**每个租户** `tenants/<userId>/config.json` → `providers.<name>.apiKey`（现有 schema，不改语义）。
- **客户端**：Flutter / 浏览器 **默认不持有** AI Key；只选 provider/model（已有流程）。  
  可选后期：`PUT /api/settings/credentials`（需租户已登录 + 仅写本租户 config），**Phase 3**。
- **扩展**：新增 OpenAI/Cursor/Anthropic 兼容 → 增加 provider 插件 + schema 枚举，**不**与租户 Token 混用。

### 1.3 与现有 `server.accessToken` 的关系

- **Phase 1 末**：保留全局 `accessToken` 仅用于 **单租户迁移期** 或 **break-glass 管理员**（可选）。
- **Phase 2 完成**：外网/multi-user 模式下以 **租户 Token** 为准；`server.accessToken` 为空或仅 loopback 管理用途。  
- **绑定规则**不变：非 loopback 必须启用鉴权（租户 token 或 legacy 全局 token 至少一种）。

---

## 2. 数据布局（单进程多租户）

```
$AICLAW_DATA_DIR/                    # 环境变量仍指向「安装根」
  auth/
    users.json                       # 租户注册表（token 哈希）
  server.json                        # host/port/cors（无 LLM 密钥、无登录口令）
  logs/                              # 进程日志
  tenants/
    <userId>/
      config.json                    # 完整 Config（providers、tools、defaults…）
      conversations/
      conversation_archive/
      knowledge_base/
      inputs/
      files/                         # usage、app_state、prompts
      logs/
```

- **迁移**：`aiclaw tenant migrate-legacy` 将当前单用户数据挪到 `tenants/default/`（或指定 id）。
- **代码原则**：所有原 `getPaths()` 调用改为 **`getPathsForTenant(userId)`** 或请求上下文 `ctx.paths`；**禁止**跨 tenant 路径拼接。

---

## 3. 分阶段实施（功能优先，部署最后）

### Phase 1 — 请求上下文与租户路径（本地，无新 UI）

**目标**：单租户行为与今天 **完全一致**，但内部已走 `tenantId + paths`。

| 步骤 | 内容 | 验证 |
|------|------|------|
| 1.1 | 引入 `TenantContext`（tenantId, paths, config） | 单元测试 |
| 1.2 | `loadConfig(configPath)` 已支持路径参数 → 绑到 tenant config | 现有 config 测试绿 |
| 1.3 | 布局只保留一种：迁移后一律 `tenants/<id>/`。未迁移的旧目录仅由 `migrate-legacy` 读取一次，运行时不再双路径 | `pnpm test --run` |
| 1.4 | 迁移 CLI + 文档；新安装直接 init `tenants/default` | 手动：会话/聊天/工具/知识库/压缩/usage 全链路 |
| 1.5 | `fs-policy`、`session`、`usage-store` 等全部读 `ctx.paths` | 回归测试 + mobile 连本地 |

**不做的**：不改鉴权模型、不改 frp。

---

### Phase 2 — 多账号 + 租户 Token（本地 + 局域网验证）

| 步骤 | 内容 | 验证 |
|------|------|------|
| 2.1 | `auth/users.json` + SHA-256 常量时间比较 | auth 单测 |
| 2.2 | `requireHttpAuth` → `resolveTenant(req)`；失败 401 | curl 两用户交叉访问会话应 404/403 |
| 2.3 | WebSocket：**upgrade 不校验 query**。连接后只接受 `auth`（及 `ping`），通过后才发 `connected`，再处理 join/chat。5 秒无 auth 则 close 4401 | mobile + web |
| 2.4 | 所有 `/api/sessions/*`、`app-state`、文档/知识库 API 带 tenant 隔离 | 集成测试 |
| 2.5 | CLI `user create / revoke / rotate / list` | 创建两用户，各写会话互不可见 |
| 2.6 | 旧客户端 query token：本阶段可认，但 Web/App **同步改为首帧**；下一次发版删除 query | 抓包确认 URL 无 token |
| 2.7 | 更新 `multi_client.md`；Web 连接门仅 **租户 Token**；App 连接页文案区分「服务器地址 / 访问令牌」 | 人工 |

**LLM Key**：仍在各租户 `config.json` 由管理员编辑；`/api/config` **继续不返回 apiKey**。

---

### Phase 3 — 体验与运维增强（按需，不阻塞 NAS 上线）

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| 3.1 | 租户自助 **轮换** 自己的 Access Token（需旧 token） | 中 |
| 3.2 | `PUT /api/settings/providers/:name` 写入 **本租户** apiKey（HTTPS，可选加密落盘） | 低（可先 SSH 改 config） |
| 3.3 | 简易 **每租户** 请求计数限流（内存滑动窗口，防 LLM 刷费） | 中（公网建议有） |
| 3.4 | 写工具 **审计**一行日志（tenant、tool、path、time） | 低 |
| 3.5 | 浏览器 **HttpOnly Session**（可选，减少 localStorage 存 token） | 低 |

---

### Phase 4 — 部署（Quant 模式，功能已绿后再做）

参考 Quant：`deploy/部署文档.md`、`docker-export-for-nas.sh`、`.command` 双击、`docker-compose-*.yml`、`*.env` 命名规范。

| 步骤 | 内容 |
|------|------|
| 4.1 | `deploy/docker-compose-aiclaw.yml`：单服务，挂载 `AICLAW_DATA_DIR` 卷，`127.0.0.1:3000` 或仅 bridge 内网口 |
| 4.2 | `deploy/aiclaw.env.example`：`AICLAW_DATA_DIR=/volume/...`，**不含** LLM Key |
| 4.3 | `deploy/script/docker-export-for-nas.sh`，入口是 `deploy/发布.command` 的第 2 项 |
| 4.4 | `deploy/部署文档.md`：NAS 导入镜像、创建项目、验收 `GET /health`、带 Bearer 测 `/api/config` |
| 4.5 | **附录：frp + 阿里云 HTTPS**（运维文档，非应用代码）：Nginx TLS → frps → NAS:3000；frp token；**禁止**公网 HTTP |
| 4.6 | 备份说明：NAS 快照 `tenants/` + `auth/` |

本地验证通过后，NAS 发布 ≈ **换运行位置 + 卷路径 + 反代**，无需改业务逻辑。

---

## 4. 功能不丢失 — 回归清单（每 Phase 末）

- [ ] 会话 CRUD、切换、生成中状态（见 `session_runtime.md`）
- [ ] WebSocket 聊天、取消、工具确认、写权限开关
- [ ] 上下文压缩、截断（服务端）
- [ ] 知识库、文档浏览、commands
- [ ] Token 用量统计
- [ ] Trilium（若启用，租户级 config）
- [ ] Mobile：连接、会话列表、聊天、Markdown
- [ ] Git 同步 API：**仍仅 loopback**（NAS 容器内若 bind 127.0.0.1 则与现逻辑一致）

---

## 5. 「遗漏项」是否值得做（现阶段判断）

| 项 | 是否值得 | 建议阶段 | 说明 |
|----|----------|----------|------|
| WS query 进日志 | **值得缓解** | Phase 2.6 | 公网/frp 下 Nginx 可能记 URL；**首帧 auth** 是性价比最高的改法 |
| Token 撤销 | **值得** | Phase 2 | `user revoke` 即可，实现小、安全收益大 |
| 限流 | **公网值得，内网可缓** | Phase 3.3 | 防 LLM 费用与滥用；单机内存限流够用，勿上 Redis |
| 审计 | **部分值得** | Phase 3.4 | 仅 **写工具** 一行日志即可，勿做大平台 SIEM |
| 备份 | **值得写文档** | Phase 4 | NAS 快照，**不必写进应用** |
| frp/Nginx 加固 | **值得写文档** | Phase 4 附录 | 运维层，TLS + frp token；**非代码** |
| LLM 密钥归属 | **核心** | Phase 1–2 | 每租户 `config.json`，已纳入设计 |
| 写权限默认关 | **已有** | — | 保持；文档强调外网勿长期开 |
| Git 同步公网关闭 | **已有** | — | 保持，不在公网 bind 上开放 |

**结论**：不是「阶段 3 全家桶才安全」；**Phase 2 + 部署文档 + WS 首帧 auth + revoke** 即可外网小团队使用。审计/限流/Session Cookie 可迭代。

---

## 6. 本地开发验证顺序（推荐）

1. 单租户 `tenants/default` 回归（Phase 1）  
2. 两租户 JSON + curl/App 交叉测试（Phase 2）  
3. `host=127.0.0.1` + 强 tenant token；可选本地 Caddy HTTPS 测 WSS  
4. 再写 deploy 脚本，NAS 上一键起容器  
5. frp 域名指向后，用 **同一套** Bearer 测外网 App/Web  

---

## 7. 文档与代码同步（完成时）

- 更新 `multi_client.md`（多租户、两类 Token、WS auth）  
- 更新 `architecture.md` 数据目录树  
- 新增 `deploy/`（与 Quant 对齐）  
- Mobile `client_surfaces.md`：外网 URL、`wss`、访问令牌 vs LLM 配置  

---

## 8. 开工前钉死（避免实现走偏）

以下在写代码前按此执行，不再二选一。

1. **目录只有一种运行时布局**：`$AICLAW_DATA_DIR/tenants/<userId>/...`。Phase 1 第一步就是 `migrate-legacy`（旧根目录 → `tenants/default`），之后 `getPaths()` 默认根不再当用户数据。
2. **进程配置与租户配置分开**：`host` / `port` / `corsOrigins` 只来自环境变量或根上 `server.json`。租户 `config.json` 仍用现有 schema 存 provider、tools、默认模型；其中 `server.accessToken` **不再作为登录凭证**（忽略或迁移时清空）。
3. **上下文必须贯穿调用链**：`chat`、`session`、`usage`、`tools/fs-policy`、`documents`、`people`、`compaction` 今天都直接 `getPaths()` / `getUserDataDir()`。用 **AsyncLocalStorage** 存当前 `TenantContext`，禁止在请求处理中改全局数据目录。`initTools(config)` 改为按租户 config 在请求内解析，不能进程启动时只 init 一次。
4. **userId** 仅 `[a-z0-9][a-z0-9_-]{0,31}`，禁止 `..` 与路径分隔符。
5. **广播按租户**：`broadcast()` 现在发给**所有** WS 客户端。多租户后只发给**同一 tenantId**（会话事件再按 sessionId）。否则 A 的会话更新会推到 B。
6. **非 loopback 启动条件**：`users.json` 至少有一个未禁用用户，**或** 过渡期仍配置了旧 `server.accessToken`。不能再只看单一 `accessToken` 字段。`/health.authRequired` 在「存在任一有效租户令牌」时为 true。
7. **WS 时序**：禁止在 auth 成功前发送 `connected` 或处理 `joinSession` / `chatMessage`。现有「upgrade 时用 query 鉴权并立刻 connected」要改掉。
8. **工具目录**：租户 `allowedDirs` 相对路径一律相对该租户根；绝对路径若越出租户根则拒绝。迁移时检查旧绝对路径。
9. **Git 同步**：仍仅 loopback，且范围改为**单个租户目录**，不要把 `auth/users.json` 整库同步出去。
10. **日志**：进程日志放 `$AICLAW_DATA_DIR/logs/`；租户业务日志可放租户目录。不要只有租户 logs。

## 9. 刻意不做（避免过度设计）

- OAuth / 第三方登录 / 多组织 RBAC  
- 每租户独立进程或 K8s  
- 在客户端保存或同步 LLM API Key（除非 Phase 3 明确要做设置页）  
- 公网 Git 同步、无鉴权 frp  

维护原则：**一个 Node 进程、租户 = 目录 + config、请求级 Context**，与现有文件型存储一致，便于 NAS 备份与排查。
