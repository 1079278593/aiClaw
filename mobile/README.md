# 移动端客户端

Flutter 工程放在本目录，只做 iOS 与 Android。服务端和桌面 Web 在 `server/`，桌面页面仍由服务进程送出，不要再拆一个根目录 `web/`。

桌面页面由 [`server/src/server/static-assets.ts`](../server/src/server/static-assets.ts) 从 `server/src/server/public/` 直接送出。`inbox/` 是另一个独立小服务，与本目录无关。

开发以本目录 `docs/` 为准，不使用 Cursor plan。阅读顺序：

1. [docs/client_surfaces.md](docs/client_surfaces.md) — 连接、界面范围、二期界面的固定行为
2. [docs/session_runtime.md](docs/session_runtime.md) — 多会话生成时的状态机与回归场景
3. [docs/api_shapes.md](docs/api_shapes.md) — 请求体、响应字段和历史消息怎么画
4. [docs/capture.md](docs/capture.md) — 按人建立的原文、历史简报与档案；咨询默认带上档案

服务端已有行为不要在客户端重写，分别见 [docs/session_switch_flow.md](../server/docs/session_switch_flow.md)、[docs/conversation_control_logic.md](../server/docs/conversation_control_logic.md)、[docs/multi_client.md](../server/docs/multi_client.md)。

启动（进入 `mobile/` 目录，且服务端已在本机或局域网启动）：

```bash
flutter run
```

真机连接：在 App 连接页填写电脑的局域网地址，例如 `http://192.168.1.10:3000`。若服务端启用了 `server.accessToken`，在数据目录的 `config.json` 里配置令牌，再在 App 中填写（勿把真实令牌写进仓库文档）。

内测发布到 fir.im：见 [docs/release_fir.md](docs/release_fir.md)。可双击 `scripts/发布到fir.command`，或 `./scripts/publish-fir.sh --help`。
