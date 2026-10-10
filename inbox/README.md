# aiclaw-inbox

手机收件箱服务：写入 `$AICLAW_DATA_DIR/inputs/chats/`。  
与 aiClaw **进程分离**，适合 NAS 部署。

## 存储模型（长期可维护）

**真相源是 append-only 的 `messages.jsonl`**（与主程序会话 JSONL 同一思路），不是「一句一个 md」。

```text
inputs/chats/<threadId>/
  meta.json           # schemaVersion、成员、dm/group、计数
  messages.jsonl      # 每行一条消息（唯一写入主账本）
  media/              # 图片等二进制
  transcript.md       # 由 jsonl 派生的可读镜像（追加同步，便于人眼/AI 扫读）
```

消息行示例：

```json
{"v":1,"id":"msg_…","ts":"2026-10-10T01:20:08.019Z","speaker":"我","type":"text","text":"……"}
{"v":1,"id":"msg_…","ts":"…","speaker":"张三","type":"image","media":{"path":"media/….jpg","mime":"image/jpeg","bytes":12345}}
```

设计要点：

- **事件日志**：只追加、不改历史，Git/备份/并发都更稳
- **schemaVersion**：以后改格式可迁移
- **稳定 message id**：可引用、可去重
- **meta / messages / media 分离**：职责清晰
- **transcript.md**：给人看；程序以 jsonl 为准

旧版「一句一文件」已废弃，勿再使用。

## 本机试跑

```bash
cd inbox
cp .env.example .env   # 设置 AICLAW_DATA_DIR、INBOX_TOKEN
pnpm install
pnpm start
```

打开 `http://127.0.0.1:8787`，填入 Token。

## API（`Authorization: Bearer <INBOX_TOKEN>`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/threads` | 会话列表 |
| POST | `/api/threads` | `{ title, kind, members? }` |
| PATCH | `/api/threads/:id` | 更新成员等 |
| GET | `/api/threads/:id/messages?limit=100` | 读取消息（时间正序） |
| POST | `/api/entries` | `{ thread, speaker, text }` → 追加 jsonl |
| POST | `/api/entries/image` | multipart: `thread`, `speaker`, `file` |

## NAS

见下方 Docker 示例；反代 HTTPS；数据 volume 挂到 aiclaw-data。

```bash
docker build -t aiclaw-inbox .
docker run -d --name aiclaw-inbox \
  -p 8787:8787 \
  -e AICLAW_DATA_DIR=/data \
  -e INBOX_TOKEN=强随机串 \
  -v /path/on/nas/aiclaw-data:/data \
  aiclaw-inbox
```

## iPhone 语音

用系统键盘听写填入文本框再提交。不够再上薄 App（同一 API）。
