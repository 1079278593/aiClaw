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

**本项目不发布 Android**：不编译、不打包、不上传。`--android` 会直接报错退出，
`--all` 按 `--ios` 处理。开发机也没有装 Android SDK。

| 项 | 说明 |
|----|------|
| Bundle ID | `com.aiclaw.aiclaw_mobile`（仅作记录，当前不使用） |

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

1. 仅 iOS（默认）  
2. 只上传已有包（不构建、不递增版本）  
0. 取消  

Android 不在本项目范围内，菜单里没有对应项。

## 命令行

在 `mobile/` 目录。**只有 iOS。**

```bash
# 默认：iOS Adhoc（build 自动 +1）
./scripts/publish-fir.sh --changelog "更新说明"

# 显式指定 iOS
./scripts/publish-fir.sh --ios --changelog "iOS Adhoc"

# 已构建过，只上传 IPA
./scripts/publish-fir.sh --ios --skip-build --no-bump
```

`--android` 会直接报错退出；`--all` 按 `--ios` 处理（仅为兼容旧脚本）。

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

- **iOS 签名失败**（`No Account for Team "…"` / `No profiles`）：
  - **在 Xcode 里配一次即可**（与 `flutter run` 真机相同）：
    ```bash
    open ios/Runner.xcworkspace
    ```
    **Runner** → **Signing & Capabilities** → **Team** 选你的账号 → 勾选 **Automatically manage signing**。Xcode 会把 Team 写进工程，之后命令行 `flutter build ipa` / 发布脚本会沿用该设置。
  - **Settings → Accounts** 里 Apple ID 需登录成功（不是只添加失败账号）。
  - 仓库已去掉他人 Team `VN7VHNN6CM`；若仍报旧 Team，说明本地 `project.pbxproj` 未保存，请在 Xcode 里重新选 Team 并 ⌘S 保存工程。
  - fir Adhoc：测试机 UDID 需在开发者账号；付费开发者账号更适合分发。
- **`No signing certificate "iOS Distribution" found` / `No signing certificate "Apple Distribution" found`**：
  打包能成，但**导出**这一步失败——`exportArchive` 找不到分发证书。这是本机钥匙串的问题，不是工程配置问题。
  ```bash
  security find-identity -v -p codesigning
  ```
  - 只看到 `Apple Development: …` → 分发证书不在本机。
    到 [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
    新建一张 **Apple Distribution** 证书，下载后双击装进 login 钥匙串。
    Ad Hoc 打包也可以用 `iOS Distribution`（旧名），二选一即可，但要与账号里有效的那张一致。
  - 也可以让 Xcode 代劳：**Xcode → Settings → Accounts → Manage Certificates → + → Apple Distribution**，
    它会自动把证书带下来。
  - 装好后重新执行上面的 `find-identity`，能看到 `Apple Distribution: … (TEAMID)` 才算好。
  - 描述文件会跟着自动重建（`Automatically manage signing` 打开时），不用手动处理。
  - **对照检查**：`security cms -D -i` 读包里的 `embedded.mobileprovision`，若
    `Name` 是 `iOS Team Provisioning Profile: *` 且 `get-task-allow: true`，那就是开发包，
    **装不上非开发机**，不能当分发件上传。
- **构建"成功"但 fir 上其实是旧包**：`flutter build ipa` 在**导出阶段失败时退出码仍是 0**，
  早期脚本会回退搜索 `build/ios/` 捡到上一次的 IPA 上传，导致 fir 标注的 build 号与实际二进制不符
  （曾发生：fir 标 20、包内是 19）。现在的脚本有三道拦截，任一不过就中止：
  1. 构建前先 `rm -rf build/ios/ipa`，失败就一定找不到包；
  2. 产物时间戳必须晚于本次流程开始时刻（`--skip-build` 时跳过这一条）；
  3. 解开 IPA 读 `Info.plist`，`CFBundleVersion` / `CFBundleShortVersionString` 必须与本次发布一致。
  看到 `✓ 产物校验通过: … → 1.0.0+N` 才算这次真发出去了。
- **`HTTP2 framing layer` / `flutter.git` fetch 失败**：脚本已设 `GIT_HTTP_VERSION=1.1`；仍失败可终端执行 `git config --global http.version HTTP/1.1` 后重试。
- **构建失败但 build 号变了**：新版本脚本只在 **上传成功** 后写回 `pubspec.yaml`。- **fir 拒绝 IPA**：确认不是 App Store 导出；必须是 Adhoc / Inhouse。
