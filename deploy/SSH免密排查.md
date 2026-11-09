# SSH 免密与发版失败排查

> 适用：`deploy/发布.command` → 「快速发版」在最后一步失败，报
> `Permission denied (publickey,password)`。
> 结论先行：**这几乎总是 NAS 侧的问题，不是脚本的问题，也不需要重新构建镜像。**

---

## 1. 先看现象落在哪一步

快速发版的顺序是固定的，日志里能清楚看到停在哪：

| 阶段 | 成功标志 | 失败说明 |
|------|----------|----------|
| 构建镜像 | `naming to docker.io/library/aiclaw:local` | 构不出来的话与 SSH 无关 |
| 导出 tar | `-rwxr-xr-x ... aiclaw-local.tar` | **到这一步为止，Mac 侧已全部成功** |
| SSH 登录 NAS | `[nas-deploy] 检查 SSH（…）` 之后出现 `SSH OK` | 若报 `Permission denied`，就是本文要解决的 |
| 加载镜像 / 重建容器 | `[nas-deploy] 已发布端口: 0.0.0.0:3010` | 没走到这里说明镜像**没有**上 NAS |

**关键判断**：只要停在 SSH，NAS 上跑的就还是**旧版本**，代码一行都没上去。
镜像和 tar 都在本机，修好 SSH 后**直接重跑部署脚本即可，不必重新构建**：

```bash
./deploy/script/docker-nas-remote-deploy.sh /Volumes/docker/aiclaw/aiclaw-local.tar
```

只想确认连通性、不动容器（推荐正式发版前先跑）：

```bash
./deploy/script/docker-nas-remote-deploy.sh check
```

---

## 2. 脚本为什么禁用交互式密码

`deploy/script/docker-nas-remote-deploy.sh` 里所有远程调用都走这个函数：

```bash
ssh_nas() {
  ssh -p "$NAS_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$NAS_SSH" "$@"
}
```

`BatchMode=yes` 的作用是**禁止一切交互式提问**（密码、host key 确认、密钥口令）。

这不是故障原因，而是有意的设计：脚本会多次调用 SSH（检查 docker、`docker load`、覆盖 compose、重启容器、查端口），如果能弹密码，第一个能弹、后面的在管道/子 shell 里会**静默挂住**，表现成“发版卡住不动”，比明确报错难查得多。

**所以看到 `Permission denied` 反而是好事——它把问题立刻暴露出来了。**

> 反过来说：只要 `BatchMode=yes` 在，密码登录就永远不可能成功。
> 这条路径**只能靠密钥**。

---

## 3. 三步定位

在本机（Mac）依次执行。

### 第 1 步：确认本机的密钥能被提供出去

```bash
ssh -v -o BatchMode=yes -o ConnectTimeout=8 ming@192.168.0.104 "echo OK" 2>&1 \
  | grep -Ei "Offering|Authentications that can continue|denied"
```

健康输出长这样（★ 两行是关键）：

```
debug1: Offering public key: /Users/ming/.ssh/id_ed25519 ED25519 SHA256:kIebLPv…★ 本机确实提供了钥匙
debug1: Authentications that can continue: publickey,password
ming@192.168.0.104: Permission denied (publickey,password).      ★ 但服务端不认
```

- **没有 `Offering public key`** → 问题在本机：私钥不存在、路径不对，或私钥带口令而 `BatchMode` 无法解锁。
- **有 `Offering` 但最终 `Permission denied`** → 钥匙送到了、**服务端拒绝了它**。往下走第 2 步。

顺带确认私钥没有口令（带口令的话 `BatchMode` 一定失败）：

```bash
ssh-keygen -y -P "" -f ~/.ssh/id_ed25519 >/dev/null && echo "无口令，OK"
```

### 第 2 步：在 NAS 上检查权限（最常见的问题）

用密码登录一次，把这几项一次看清楚：

```bash
ssh ming@192.168.0.104 'id; echo "HOME=$HOME"; \
  ls -ld "$HOME" "$HOME/.ssh"; ls -l "$HOME/.ssh/authorized_keys"; \
  echo "--- 含 openclaw 的行数 ---"; grep -c openclaw "$HOME/.ssh/authorized_keys"; \
  echo "--- sshd_config ---"; \
  grep -Ei "^(AuthorizedKeysFile|PubkeyAuthentication|StrictModes|UsePAM)" /etc/ssh/sshd_config'
```

需要满足（OpenSSH 默认 `StrictModes yes`）：

| 检查项 | 必须 |
|--------|------|
| 家目录权限 | **不能对 group/other 可写**（`750` 或 `700`） |
| `~/.ssh` | `700` |
| `~/.ssh/authorized_keys` | `600`，且所有者是自己 |
| `authorized_keys` 内容 | 含有本机 `~/.ssh/id_ed25519.pub` 那一行 |

**只要家目录带 `w` 给 group 或 other，sshd 会直接忽略 `authorized_keys`**，然后回退到密码——而 `BatchMode` 又把密码禁掉了，于是报 `Permission denied`。

### 第 3 步：看 sshd 日志，它会直接点名

不想逐项猜的话，这一步最快：

```bash
ssh ming@192.168.0.104 'sudo tail -30 /var/log/auth.log 2>/dev/null \
  || sudo journalctl -u ssh -n 30 --no-pager'
```

典型一行：

```
Authentication refused: bad ownership or modes for directory /home/ming
```

---

## 4. 一次真实故障（2026-11-09）

记录下来，因为它的表现很有欺骗性。

### 现象

```
[nas-deploy] 检查 SSH（ming@192.168.0.104 -p 22）…
ming@192.168.0.104: Permission denied (publickey,password).
```

### 排查过程

1. `ssh -v` 显示 **本机已提供** `id_ed25519`，指纹 `SHA256:kIebLPvvNjQxU3JcupmuCA4/dW+KotBWYtX4lZIMEkA`，但被服务端拒绝。
2. 私钥**没有口令**，排除 `BatchMode` 解锁失败。
3. 执行 `ssh-copy-id`，输出 `Number of key(s) added: 1`，看起来成功——**但立刻测试仍然被拒绝**（见下一节的“假成功”）。
4. 在 NAS 上检查，发现问题：

```
uid=1000(ming) gid=10(admin) groups=10(admin),100(users),121(docker),133(ughomeusers)
HOME=/home/ming
drwxrwxrwx+ 11 ming admin 4096 Nov  4 23:20 /home/ming     ← 罪魁祸首：777
drwx------   2 ming admin 4096 Sep  6 10:28 /home/ming/.ssh
-rw-------   1 ming admin 190 Nov  9 07:59 /home/ming/.ssh/authorized_keys
--- 含 openclaw 的行数 ---
2
```

`authorized_keys` **完全正常**（权限 `600`、所有者正确、公钥在里面），唯一不合格的是**家目录 `777`**。sshd 因此拒绝读取该文件。

5. `sshd_config` 里只显式写了 `UsePAM yes`，其余三项（`AuthorizedKeysFile`、`PubkeyAuthentication`、`StrictModes`）**都是默认值**——也就是说配置没被动过，问题纯粹在文件权限。

### 为什么会“突然”坏

时间线是关键证据：

| 时间 | 事件 |
|------|------|
| 10-29 23:37 | `BatchMode=yes` 被加入脚本（此后仍正常） |
| 10-29 ~ 10-31 | 连续成功发版 **服务 4 / 5 / 6 / 7 / 8** 共五次 |
| **11-04 23:20** | **`/home/ming` 的 mtime 变成这个时间点，权限为 `777`** |
| 11-09 07:40 | 再次发版，SSH 失败 |

所以 `BatchMode` 从不是原因（它上线后又成功发版五次），真正变化的是 **11 月 4 日家目录权限被改成了全员可写**——大概率是装了某个应用、或通过 NAS 的共享/权限界面调整过。末尾的 `+` 表示还存在 ACL，清理时要一并确认。

### 修复

```bash
ssh ming@192.168.0.104 'chmod 750 /home/ming && ls -ld /home/ming'
```

用 `750` 而非 `700`：主组是 `admin`，`750` 允许同组读取、同时挡住 other。
**不要用 `755` 或 `777`**——`755` 虽不支持 group 写，但把目录开放给了 other；`777` 就是本次故障。

若 `chmod` 后 ACL 仍残留（`ls -ld` 依旧带 `+` 且行为未恢复），补查：

```bash
ssh ming@192.168.0.104 'getfacl /home/ming'
```

确实需要清理时用 `setfacl -b /home/ming`，**但先确认没有 NAS 服务依赖那些 ACL 条目**。

验证（不输入密码）：

```bash
ssh -o BatchMode=yes ming@192.168.0.104 "echo SSH OK"
```

看到 `SSH OK` 即恢复。然后重跑第 1 节末尾的部署命令，**不需要重新构建镜像**。

---

## 5. `ssh-copy-id` 的“假成功”

这次最误导人的一步。看它的输出顺序：

```
INFO: attempting to log in with the new key(s), to filter out any that are already installed
INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys
Number of key(s) added: 1
```

`Number of key(s) added: 1` 很容易让人以为“配好了”。但它实际做的是：

1. 先**用自己的密钥试着登录**，过滤掉已生效的；
2. 试登录**失败**（因为 sshd 读不到 `authorized_keys`），于是判定“这把还没装”；
3. 把公钥**追加**进去（如果已存在就会变成重复行）——于是又出现了 `added: 1` 这样的误导输出；
4. 它**不会**回头再验证一次密钥登录是否真的可用。

结果就是：**文件写进去了，但登录依旧失败**，而且多了一条重复公钥（本次 `openclaw` 计数为 2 就是这个原因）。

> 判断标准：`ssh-copy-id` 之后**必须**用 `ssh -o BatchMode=yes … "echo SSH OK"` 复验。
> 不复验就等于没验证。

清理重复行（确认只剩一行时）：

```bash
ssh ming@192.168.0.104 'sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys && grep -c openclaw ~/.ssh/authorized_keys'
```

---

## 6. 排查清单（按命中率排序）

| # | 原因 | 判定 | 修复 |
|---|------|------|------|
| 1 | 家目录权限过宽（`777`/`775`） | `ls -ld ~` 中 group 或 other 带 `w` | `chmod 750 ~` |
| 2 | `~/.ssh` 或 `authorized_keys` 权限错 | 非 `700` / 非 `600` | `chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys` |
| 3 | 公钥根本没装（系统重装后丢失） | `grep openclaw ~/.ssh/authorized_keys` 为 0 | `ssh-copy-id -i ~/.ssh/id_ed25519.pub …` |
| 4 | ACL 覆盖了基本权限 | `ls -ld` 末尾有 `+` | `getfacl` 确认后 `setfacl -b` |
| 5 | `AuthorizedKeysFile` 指向别处 | 非默认值 | 把公钥放到 sshd 实际读取的路径（需 sudo） |
| 6 | `PubkeyAuthentication no` | 显式配置为 no | 改为 `yes` 并重启 sshd |
| 7 | 本机私钥带口令 | `ssh-keygen -y -P "" …` 失败 | 去掉口令，或改用 `ssh-agent` 并保证脚本能访问 |
| 8 | 换了 NAS / 换了账号 | `NAS_SSH` 与 `id` 不符 | 更新 `deploy/nas.env` |

第 1、2、3 条覆盖绝大多数情况。

---

## 7. 相关文件

- `deploy/nas.env`：`NAS_SSH`、`NAS_PROJECT_DIR`（本机私用，已 gitignore）
- `deploy/script/docker-nas-remote-deploy.sh`：SSH 调用集中在这里的 `ssh_nas()`
- `deploy/script/docker-export-for-nas.sh`：构建、导出、可选地调用上面的部署
- `deploy/部署文档.md`：发布流程与首次配置

> **注意**：`deploy/部署文档.md` 只描述了“快速发版会用 SSH 执行 `docker load`”，
> 把“密钥已配好”当成既有前提，没有讲免密怎么配、坏了怎么修。
> 这个前提在 NAS 重装、权限被改之后就不再成立——本文就是补这个缺口。

---

## 8. 一句话

**`Permission denied (publickey,password)` + `BatchMode=yes`，意味着只能走密钥；
先确认本机 `Offering public key`，再去 NAS 上查 `ls -ld ~` 是否给 group/other 留了写权限。
`ssh-copy-id` 报 “added” 不代表成功，唯一判据是 `ssh -o BatchMode=yes … "echo SSH OK"`。**
