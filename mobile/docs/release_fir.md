# 发布到 fir.im（内测分发）

fir 只接受 **Android APK** 和 **iOS Adhoc / Inhouse 的 IPA**，不接受 App Store 包。官方说明：[发布应用](https://www.betaqr.com.cn/docs/publish)。

## 你需要准备什么

### 1. fir 账号

1. 注册 [fir.im / betaqr](https://www.betaqr.com.cn/)
2. 控制台创建应用（或首次上传时按 Bundle ID 自动创建）
3. **账户设置 → API Token**（32 位）→ 写入 `scripts/fir.env`：

```bash
cp scripts/fir.env.example scripts/fir.env
# 编辑 FIR_API_TOKEN=...
```

`fir.env` 已 gitignore，不要提交 token。

### 2. 版本号（脚本自动）

每次**正常发布**（会执行构建）时，脚本会把 `pubspec.yaml` 写成 **`x.y.z+build`** 并 **build +1**：

- 默认保持营销版本 **1.0.0**（或 `pubspec` / `fir.env` 里 `FIR_MARKETING_VERSION` 的 x.y.z）
- 例：`1.0.0+1` → 发布 → `1.0.0+2`，再上传 fir

不必手改版本。仅上传旧包时用 `--skip-build --no-bump`（双击菜单第 4 项）。

### 3. Android

| 项 | 说明 |
|----|------|
| 产物 | `flutter build apk --release` |
| 签名 | 当前工程 release 仍用 **debug 签名**（见 `android/app/build.gradle.kts`），内测可以；正式对外建议配置 release keystore |
| Bundle ID | `com.aiclaw.aiclaw_mobile` |

### 4. iOS（比 Android 多）

| 项 | 说明 |
|----|------|
| 产物 | `flutter build ipa --export-method=ad-hoc`（或 `enterprise`） |
| 证书 | Apple Developer；Xcode **Signing** 配好 Team |
| 设备 | **Adhoc**：测试机 UDID 须在描述文件里；**Inhouse**：企业账号 |
| Bundle ID | `com.aiclaw.aiclawMobile`（须与 Xcode 一致） |
| 真机 | **发布瞬间不必插手机**；但 Adhoc 包只能装已登记 UDID 的设备 |

`scripts/fir.env` 里 `IOS_EXPORT_METHOD=ad-hoc` 或 `enterprise`。

## 双击发布（macOS）

在 Finder 中打开 `mobile/scripts/`，双击 **发布到fir.command**。**首次**若无法双击：

```bash
chmod +x mobile/scripts/发布到fir.command mobile/scripts/publish-fir.sh
```

菜单选项（若使用 `.command`）：

1. 仅 iOS（默认推荐）  
2. 仅 Android  
3. Android + iOS 双端  
4. 只上传已有包（不构建、不递增版本）  
0. 取消  

## 命令行

在 `mobile/` 目录。**默认只发 iOS，不发 Android。**

```bash
# 默认：仅 iOS Adhoc（build 自动 +1）
./scripts/publish-fir.sh --changelog "更新说明"

# 显式仅 iOS
./scripts/publish-fir.sh --ios --changelog "iOS Adhoc"

# 仅 Android（需显式指定）
./scripts/publish-fir.sh --android --changelog "Android 内测"

# 两平台
./scripts/publish-fir.sh --all --changelog "双端"

# 已构建过，只上传 IPA
./scripts/publish-fir.sh --ios --skip-build --no-bump
```

无 `scripts/fir.env` 时会读本机 `~/.fir-cli` 的 token。

依赖：本机已安装 **Flutter**、**curl**；iOS 还需 **Xcode + CocoaPods**。

## 可选：fir-cli

若已安装 Ruby gem：

```bash
gem install fir-cli
fir p build/app/outputs/flutter-apk/app-release.apk -T "$FIR_API_TOKEN" -c "更新说明"
```

脚本默认走 **HTTP API**（`api.appmeta.cn`），不依赖 fir-cli。

## 常见问题

- **第一次内测建议选菜单 1（仅 Android）**：不需要 Apple 签名，先验证 fir token 与上传流程。
- **iOS 签名失败**（`No Account for Team "…"` / `No profiles`）：
  - **在 Xcode 里配一次即可**（与 `flutter run` 真机相同）：
    ```bash
    open ios/Runner.xcworkspace
    ```
    **Runner** → **Signing & Capabilities** → **Team** 选你的账号 → 勾选 **Automatically manage signing**。Xcode 会把 Team 写进工程，之后命令行 `flutter build ipa` / 发布脚本会沿用该设置。
  - **Settings → Accounts** 里 Apple ID 需登录成功（不是只添加失败账号）。
  - 仓库已去掉他人 Team `VN7VHNN6CM`；若仍报旧 Team，说明本地 `project.pbxproj` 未保存，请在 Xcode 里重新选 Team 并 ⌘S 保存工程。
  - fir Adhoc：测试机 UDID 需在开发者账号；付费开发者账号更适合分发。
- **`HTTP2 framing layer` / `flutter.git` fetch 失败**：脚本已设 `GIT_HTTP_VERSION=1.1`；仍失败可终端执行 `git config --global http.version HTTP/1.1` 后重试。
- **构建失败但 build 号变了**：新版本脚本只在 **上传成功** 后写回 `pubspec.yaml`。
- **fir 拒绝 IPA**：确认不是 App Store 导出；必须是 Adhoc / Inhouse。
- **Android 装不上**：检查是否用了 release APK，以及是否允许安装未知来源。
