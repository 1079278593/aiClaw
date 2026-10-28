# 多端支撑（主服务 API）

同一套 HTTP / WebSocket API 可供桌面浏览器、手机浏览器与未来 App 共用。本期能力：访问令牌鉴权、CORS、非本机绑定安全约束、前端最小凭证适配。

本期不做：合并 `inbox/`、手机整页 UI、原生 App、OAuth / 多用户。

## 配置

在 `config.json` 的 `server` 中：

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1",
    "accessToken": "",
    "corsOrigins": []
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `accessToken` | `""` | 非空时，所有 `/api/*` 与 WebSocket 必须带凭证 |
| `corsOrigins` | `[]` | 允许的 Origin 列表；`["*"]` 表示任意来源；空则不发 CORS 头 |

### 启动规则

| 绑定 | accessToken | 行为 |
|------|-------------|------|
| loopback（`127.0.0.1` / `localhost` / `::1`） | 空 | 本机免鉴权（与历史行为一致） |
| 非 loopback（如 `0.0.0.0`） | 空 | **拒绝启动** |
| 任意 host | 非空 | API / WS 必须带凭证 |

## HTTP

- 公开：`GET /health` → `{ "status": "ok", "authRequired": boolean, "version": string, "commit": string }`（不含密钥）。`version` 是 NAS 发版号，`commit` 是构建时的 git 短哈希。本地直接启动时 `version` 为 `dev`、`commit` 为空。
- 受保护：`/api/*` 需 `Authorization: Bearer <accessToken>`（当 `authRequired` 为 true）
- 静态资源（`/`、`/js/*`、`/styles/*` 等）可匿名访问
- 鉴权失败：`401` + `{ "error": "Unauthorized" }`
- CORS：按 `corsOrigins` 处理 `OPTIONS` 预检，并允许 `Authorization`、`Content-Type`

## WebSocket

- 连接：`ws(s)://{host}:{port}/ws`，不在 URL 上放 token
- 连接成功后立刻发送 `{ "type": "auth", "token": "<token>" }`
- 服务端校验通过后才下发 `{ "type": "connected" }`。在此之前只接受 `auth` 和 `ping`
- 未在 5 秒内通过鉴权，或凭证错误，关闭码 `4401`
- 本机免鉴权模式：不发 `auth` 也会收到 `connected`
- 旧客户端的 `?access_token=` 仍可用一版，新客户端不要再用

## 前端适配

- `localStorage` 键：`<brand>-access-token`（见 `access-token.js`）
- `api.js` 的 `requestJson` 自动附加 `Authorization`
- `websocket.js` 在 `open` 后发送 `{ type: "auth", token }`，收到 `connected` 才视为已连接
- 若 `/health.authRequired` 且本地无 token，显示简易输入门后再启动

## 客户端调用示例

```bash
# 健康检查（公开）
curl -s http://127.0.0.1:3000/health

# 受保护 API
curl -s -H "Authorization: Bearer YOUR_TOKEN" \
  http://0.0.0.0:3000/api/config
```

```js
const ws = new WebSocket("ws://192.168.1.10:3000/ws");
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "auth", token }));
});
```

## 安全注意

- 局域网或公网绑定必须有强 `accessToken`，或至少一个未停用的 `user create` 用户
- Git 同步相关 API 仍仅在 loopback 绑定下启用
- 生产环境使用 HTTPS/WSS。多用户 token 存在安装根目录 `auth/users.json`，只保存哈希
