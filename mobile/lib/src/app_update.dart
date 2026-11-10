/// App 内更新的数据模型与版本比较。
///
/// 这个文件**不碰网络、不碰 UI**，只做纯计算，方便单测。
/// 因为「有没有新版本」这个判断一旦写错，用户要么永远收不到更新，
/// 要么每次启动都被一个假的更新提示骚扰，两种都比没有这个功能更糟。
///
/// 版本来源是服务端 `/api/app/update`，服务端再去问 fir；
/// fir 的 token 只存在于服务端，客户端从头到尾见不到。
library;

import 'package:flutter/foundation.dart';

@immutable
class AppUpdateInfo {
  const AppUpdateInfo({
    required this.platform,
    required this.configured,
    required this.available,
    this.version,
    this.build,
    this.changelog,
    this.updatedAt,
    this.installUrl,
    this.updateUrl,
    this.sizeBytes,
    this.reason,
  });

  final String platform;

  /// 服务端是否配好了 fir token。false 时入口应隐藏，而不是显示报错。
  final bool configured;

  /// fir 上是否已有该平台的包（Android 目前为 false，属正常）。
  final bool available;

  final String? version;
  final String? build;
  final String? changelog;
  final String? updatedAt;
  final String? installUrl;
  final String? updateUrl;
  final int? sizeBytes;

  /// 未配置或查不到时的说明，可直接展示。
  final String? reason;

  /// 能否点一下就装：只有 `itms-services` / 直链安装才算。
  /// 单纯的更新网页短链需要用户自己在浏览器里操作，属于「查看」而非「安装」。
  bool get canInstallDirectly {
    final url = installUrl;
    if (url == null || url.isEmpty) return false;
    return url.startsWith('itms-services://') || url.startsWith('https://') || url.startsWith('http://');
  }

  /// 能跳转的链接：优先安装链接，其次更新页。
  String? get launchUrl {
    final install = installUrl;
    if (install != null && install.isNotEmpty) return install;
    final update = updateUrl;
    if (update != null && update.isNotEmpty) return update;
    return null;
  }

  static AppUpdateInfo? tryParse(Object? json) {
    if (json is! Map) return null;
    String? str(String key) {
      final value = json[key];
      return value is String && value.isNotEmpty ? value : null;
    }

    final platform = str('platform');
    if (platform == null) return null;
    final size = json['sizeBytes'];
    return AppUpdateInfo(
      platform: platform,
      configured: json['configured'] == true,
      available: json['available'] == true,
      version: str('version'),
      build: str('build'),
      changelog: str('changelog'),
      updatedAt: str('updatedAt'),
      installUrl: str('installUrl'),
      updateUrl: str('updateUrl'),
      sizeBytes: size is num ? size.toInt() : null,
      reason: str('reason'),
    );
  }
}

/// 比较结果：是否值得提示更新。
enum UpdateDecision {
  /// 没有更新，或信息不足，静默。
  none,

  /// 有新版本可装。
  updateAvailable,
}

/// 判断「服务端的最新版」是否比「本机版本」新。
///
/// 规则（有意保守，宁可漏提示也不要误提示）：
/// 1. `available == false` 或没有 build → 不提示。
/// 2. 本机版本未知 → 不提示。宁可让用户手动点「检查更新」，
///    也不要因为读不到本机版本就弹一个「有新版本」。
/// 3. **先比 build（构建号）**：build 是单调递增的整数，
///    是最可靠的依据。版本名是营销号，可能被回填或跳号。
/// 4. build 相同或无法比时，再比版本名（按数字段逐段比较，
///    不能按字符串比——否则 "1.10.0" < "1.9.0"）。
///
/// 相等一律视为「无更新」，避免同版本反复提示。
UpdateDecision decideUpdate({
  required AppUpdateInfo? remote,
  required String? localBuild,
  required String? localVersion,
}) {
  if (remote == null || !remote.configured || !remote.available) return UpdateDecision.none;

  // 构建号优先：它单调递增，比营销版本名可靠。
  final buildCmp = compareBuilds(remote.build, localBuild);
  if (buildCmp != null && buildCmp != 0) {
    return buildCmp > 0 ? UpdateDecision.updateAvailable : UpdateDecision.none;
  }
  // build 相同、缺失，或含非数字段而无法判定时，退化为比版本名。
  // 两侧都读不到 → 无法判定 → 静默（宁可漏提示，也不误报）。

  final cmp = compareVersions(remote.version, localVersion);
  if (cmp == null) return UpdateDecision.none;
  return cmp > 0 ? UpdateDecision.updateAvailable : UpdateDecision.none;
}

/// 比较构建号：`13.2` > `13.1`，`14` > `13`。
///
/// 构建号（iOS 的 CFBundleVersion）允许带点，所以**不能**只取第一段，
/// 否则 `13.2` 和 `13.1` 会被当成同一个版本，用户永远收不到这次更新。
/// 任一侧缺失或含非数字段（罕见但合法）返回 null，由调用方退回比版本名。
int? compareBuilds(String? a, String? b) {
  final left = _numericSegments(a);
  final right = _numericSegments(b);
  if (left == null || right == null) return null;
  final length = left.length > right.length ? left.length : right.length;
  for (var i = 0; i < length; i++) {
    final l = i < left.length ? left[i] : 0;
    final r = i < right.length ? right[i] : 0;
    if (l != r) return l > r ? 1 : -1;
  }
  return 0;
}

List<int>? _numericSegments(String? raw) {
  if (raw == null) return null;
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return null;
  final parts = trimmed.split(RegExp(r'[.\-_]'));
  final result = <int>[];
  for (final part in parts) {
    if (part.isEmpty) continue;
    final value = int.tryParse(part);
    if (value == null) return null;
    result.add(value);
  }
  return result.isEmpty ? null : result;
}

/// 按「点分段」比较两个版本名：`1.10.0` > `1.9.0`。
///
/// 返回 null 表示**无法判定**（任一侧缺失或非法），调用方应按「不更新」处理。
/// 非数字段（如 `1.0.0-beta`）按字符串比较，保证不会抛异常。
int? compareVersions(String? a, String? b) {
  if (a == null || b == null) return null;
  final left = _segments(a);
  final right = _segments(b);
  if (left.isEmpty || right.isEmpty) return null;

  final length = left.length > right.length ? left.length : right.length;
  for (var i = 0; i < length; i++) {
    // 缺段按 0 处理：`1.0` 与 `1.0.0` 相等，而不是「更小」。
    // 尾部还带非数字标记时才走下面「数字 > 字符串」的正式版优先规则。
    final l = i < left.length ? left[i] : '0';
    final r = i < right.length ? right[i] : '0';
    final ln = int.tryParse(l);
    final rn = int.tryParse(r);
    if (ln != null && rn != null) {
      if (ln != rn) return ln > rn ? 1 : -1;
      continue;
    }
    // 一侧是数字、另一侧是字符串（预发布标记）：数字版视为更新。
    if (ln != null && rn == null) return 1;
    if (ln == null && rn != null) return -1;
    final cmp = l.compareTo(r);
    if (cmp != 0) return cmp > 0 ? 1 : -1;
  }
  return 0;
}

List<String> _segments(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return const [];
  return trimmed
      .split(RegExp(r'[.\-+]'))
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .toList();
}

/// 把字节数变成人能读的大小，用于对话框副标题。
String formatBytes(int? bytes) {
  if (bytes == null || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  final text = unit == 0 ? value.toStringAsFixed(0) : value.toStringAsFixed(1);
  return '$text ${units[unit]}';
}
