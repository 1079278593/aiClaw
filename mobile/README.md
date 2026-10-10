# 移动端客户端

Flutter 工程放在本目录，只做 iOS 与 Android。服务端和桌面 Web 在 `server/`，桌面页面仍由服务进程送出，不要再拆一个根目录 `web/`。

桌面页面由 [`server/src/server/static-assets.ts`](../server/src/server/static-assets.ts) 从 `server/src/server/public/` 直接送出。`inbox/` 是另一个独立小服务，与本目录无关。

开发以本目录 `docs/` 为准，不使用 Cursor plan。阅读顺序：

1. [docs/client_surfaces.md](docs/client_surfaces.md) — 连接、界面范围、二期界面的固定行为
2. [docs/session_runtime.md](docs/session_runtime.md) — 多会话生成时的状态机与回归场景
3. [docs/api_shapes.md](docs/api_shapes.md) — 请求体、响应字段和历史消息怎么画

服务端已有行为不要在客户端重写，分别见 [docs/session_switch_flow.md](../server/docs/session_switch_flow.md)、[docs/conversation_control_logic.md](../server/docs/conversation_control_logic.md)、[docs/multi_client.md](../server/docs/multi_client.md)。

启动：
真机连接：http://192.168.31.251:3000
token在：~/aiclaw-data/config.json  的文件内。