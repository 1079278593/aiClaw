/// 「检查更新」的 UI。
///
/// 设计取舍：
/// - **不自动弹窗**。启动就弹更新框是很烦人的行为，尤其在 Adhoc 分发下
///   用户可能就是想留在旧版。这里只在「更多」页给一个入口，用户点才查。
/// - 三态明确：服务端没配 → 隐藏（不显示坏按钮）；查不到 → 说明原因；
///   有新版本 → 卡片 + 详情弹窗 + 一键安装。
/// - 安装走 `itms-services://`，由系统弹「是否安装」，不经过 App Store。
library;

import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../src/app_controller.dart';
import '../src/app_update.dart';

class UpdateTile extends StatefulWidget {
  const UpdateTile({super.key, required this.controller});
  final AppController controller;

  @override
  State<UpdateTile> createState() => _UpdateTileState();
}

class _UpdateTileState extends State<UpdateTile> {
  var _loading = false;
  String? _localVersion;
  String? _localBuild;
  AppUpdateInfo? _remote;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadLocalVersion();
  }

  Future<void> _loadLocalVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      if (!mounted) return;
      setState(() {
        _localVersion = info.version;
        _localBuild = info.buildNumber;
      });
    } catch (_) {
      // 读不到本机版本不算错误，只是无法自动判断，用户仍可手动查。
    }
  }

  Future<void> _check() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final info = await widget.controller.checkAppUpdate();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _remote = info;
      if (info == null) _error = '无法连接服务，检查网络或服务是否在线';
    });
    if (info == null) return;

    final decision = decideUpdate(
      remote: info,
      localBuild: _localBuild,
      localVersion: _localVersion,
    );
    if (!mounted) return;
    if (decision == UpdateDecision.updateAvailable) {
      await _showUpdateDialog(info);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(info.reason ?? '已是最新版本')),
      );
    }
  }

  Future<void> _showUpdateDialog(AppUpdateInfo info) async {
    final size = formatBytes(info.sizeBytes);
    final subtitleParts = <String>[
      if (_localBuild != null) '当前 ${_localVersion ?? '?'} (${_localBuild!})',
      if (info.version != null) '最新 ${info.version!}${info.build != null ? ' (${info.build!})' : ''}',
      if (size.isNotEmpty) size,
    ];

    final action = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('发现新版本'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(subtitleParts.join(' · '), style: Theme.of(context).textTheme.bodySmall),
              if (info.changelog != null && info.changelog!.trim().isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(info.changelog!.trim()),
              ],
              if (info.updatedAt != null) ...[
                const SizedBox(height: 12),
                Text('发布于 ${info.updatedAt!.replaceAll('T', ' ').split('.').first}',
                    style: Theme.of(context).textTheme.bodySmall),
              ],
              const SizedBox(height: 12),
              // 说清楚装的是什么、会覆盖谁、不留文件。
              // Adhoc 覆盖安装是原地替换，用户需要知道这一点。
              Text(
                info.canInstallDirectly
                    ? '点「立即安装」后由系统接管：会直接覆盖当前版本，不经过浏览器，也不在「文件」里留下安装包。'
                    : '这次没有可直接安装的地址，无法在 App 内完成更新。',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop('later'), child: const Text('稍后')),
          FilledButton(
            // 没有可安装地址时禁用按钮，而不是让它点了报错。
            onPressed: info.canInstallDirectly
                ? () => Navigator.of(context).pop('install')
                : null,
            child: const Text('立即安装'),
          ),
        ],
      ),
    );

    if (action == 'install') await _launch(info);
  }

  Future<void> _launch(AppUpdateInfo info) async {
    // 只走安装路径。绝不用 web 页兜底——那会让用户点进一个下载页，
    // 结果反而在「文件」里留下一份管不到的 ipa。
    final target = info.installTarget;
    if (target == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('服务端没有返回可直接安装的地址')),
      );
      return;
    }
    final uri = Uri.tryParse(target);
    if (uri == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('安装链接无效')));
      return;
    }

    // 必须是 externalApplication：itms-services 要由系统安装器接手，
    // inApp 模式找不到处理器会直接失败。
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!launched && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('无法唤起安装，请检查是否为企业/Adhoc 签名的包')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final remote = _remote;
    // 明确排除「服务端没配 token」：与其摆一个点了就说不支持的按钮，不如不显示。
    if (remote != null && !remote.configured) {
      return const SizedBox.shrink();
    }

    final decision = decideUpdate(
      remote: remote,
      localBuild: _localBuild,
      localVersion: _localVersion,
    );
    final hasUpdate = decision == UpdateDecision.updateAvailable;

    return ListTile(
      leading: Icon(hasUpdate ? Icons.system_update_alt : Icons.refresh),
      title: Text(hasUpdate ? '有新版本 ${remote?.version ?? ''}'.trim() : '检查更新'),
      subtitle: Text(
        _error
            ?? (hasUpdate
                ? '当前 ${_localVersion ?? '?'} (${_localBuild ?? '?'})，点击安装'
                : remote?.reason ?? '当前 ${_localVersion ?? '?'} (${_localBuild ?? '?'})'),
      ),
      trailing: _loading
          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
          : null,
      onTap: _loading ? null : (hasUpdate ? () => _showUpdateDialog(remote!) : _check),
    );
  }
}
