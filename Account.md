# 账号

租户访问令牌和模型服务商的 API Key 是两样东西。这里只讲访问令牌：它证明「是哪个用户在连 aiClaw」。模型密钥写在该用户自己的 `config.json` 里，不会发给浏览器或 App。

以下命令都在 `server/` 目录执行。`pnpm` 要找到这个包，并且从这里的 `.env` 读到 `AICLAW_DATA_DIR`。在仓库根目录或其他目录执行会失败，或写到错误的数据目录。

服务器开着或关着都可以执行。这些命令直接改 `$AICLAW_DATA_DIR/auth/users.json`。服务已经在跑时，下一次 HTTP 或 WebSocket 鉴权会读到新文件，不用为了新建、轮换、停用而重启。

## 现有命令

```bash
cd server
pnpm exec tsx src/cli/index.ts user create ming
pnpm exec tsx src/cli/index.ts user list
pnpm exec tsx src/cli/index.ts user rotate ming
pnpm exec tsx src/cli/index.ts user revoke ming
```

| 命令 | 作用 |
|------|------|
| `user create <id>` | 新建用户，初始化 `tenants/<id>/`，并打印访问令牌 |
| `user list` | 列出用户 id、是否停用、备注、创建时间。不显示令牌 |
| `user rotate <id>` | 作废旧令牌，打印新令牌。旧令牌立即不能用 |
| `user revoke <id>` | 停用该用户。令牌立即不能用，数据目录保留 |

可选备注：`user create ming -l "我的手机"`。

用户 id 只能是小写字母、数字、`_`、`-`，最长 32 个字符，并且不能以 `_` 或 `-` 开头。例如 `ming`、`ming2`。

## 令牌要自己保存

`create` 和 `rotate` 成功后，明文令牌只在终端出现一次。服务端只把 SHA-256 哈希写进 `auth/users.json`，之后无法再查回原文。

看到输出后立刻复制到密码管理器或你自己的笔记。丢掉了就对该用户执行 `user rotate`，把新令牌填回浏览器或 App。不要把令牌提交进 git。

原来的 `server.accessToken` 仍然可以登录 `tenants/default`。`user create` 出来的是另一个用户，数据在 `tenants/<id>/`。

## 已登录后可以做的事

网页齿轮菜单和 App「更多」里的「服务与模型」只改当前账号：模型密钥、默认模型、Trilium、网页搜索。密钥留空表示不改，点清除再保存才会去掉。

同一页可以「轮换访问令牌」。旧令牌马上失效，新令牌只显示一次。当前这个浏览器或手机会改用新令牌，其他设备要重新填写。

每个账号每分钟最多约 180 次接口请求、30 次新对话。超过后会提示稍后再试，重启服务会清空这个计数。

写文件、改文件、移动和删除会在进程日志里留一行：账号、工具、路径、是否成功。日志不包含文件内容。

## 尚未实现

浏览器改为 HttpOnly Cookie，少在 `localStorage` 里放令牌。公网没有自助注册，新用户仍然由管理员执行 `user create`。
