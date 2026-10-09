# aiclaw-inbox

手机收件箱：把文字 / 图片写入 `$AICLAW_DATA_DIR/inputs/chats/<会话>/`，带说话人字段。  
与主程序 **进程分离**，适合部署在 NAS；本机也可先试跑。

## 落盘约定

```text
inputs/chats/
  张三/
    _thread.json
    2026-10-09_153012_001.md
  周末聚餐/
    _thread.json
    2026-10-09_160001_001.md
```

`_thread.json` 示例：

```json
{
  "title": "张三",
  "members": ["我", "张三"],
  "kind": "dm"
}
```

条目 Markdown 含 YAML：`speaker` / `time` / `thread`。

## 本机试跑

```bash
cd inbox
cp .env.example .env
# 编辑 .env：AICLAW_DATA_DIR、INBOX_TOKEN
pnpm install   # 或 npm install
pnpm start
```

浏览器打开 `http://127.0.0.1:8787`，填入 Token。

## API（均需 `Authorization: Bearer <INBOX_TOKEN>`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/threads` | 会话列表 |
| POST | `/api/threads` | `{ title, kind, members? }` |
| PATCH | `/api/threads/:id` | 更新 members 等 |
| POST | `/api/entries` | `{ thread, speaker, text }` |
| POST | `/api/entries/image` | multipart: `thread`, `speaker`, `file` |

## NAS 部署提示

1. 数据目录挂到容器：`AICLAW_DATA_DIR=/data` → volume 映射你的 aiclaw-data。
2. 设置强随机 `INBOX_TOKEN`。
3. 反代 HTTPS 到 `8787`（与 Trilium 同类）。
4. iPhone 用 Safari 打开该域名；语音用**系统键盘听写**后点提交。

```bash
docker build -t aiclaw-inbox .
docker run -d --name aiclaw-inbox \
  -p 8787:8787 \
  -e AICLAW_DATA_DIR=/data \
  -e INBOX_TOKEN=你的强随机串 \
  -v /path/on/nas/aiclaw-data:/data \
  aiclaw-inbox
```

## 语音说明（iPhone）

一期不内置 Web Speech。点输入框 → 键盘麦克风听写 → 确认文字 → 提交。体验不够再考虑薄 App（同一 API）。
