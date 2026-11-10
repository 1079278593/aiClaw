/// 更新判断的纯逻辑测试。
///
/// 这些用例的价值全在边界上：字符串比版本号、build 相同但版本名变了、
/// 本机版本读不到时**不能**误报更新。写错任何一条，
/// 用户要么永远收不到更新，要么每次都被假提示打扰。
library;

import 'package:aiclaw_mobile/src/app_update.dart';
import 'package:flutter_test/flutter_test.dart';

AppUpdateInfo remote({
  String? version = '1.0.1',
  String? build = '14',
  bool available = true,
  bool configured = true,
}) {
  return AppUpdateInfo(
    platform: 'ios',
    configured: configured,
    available: available,
    version: version,
    build: build,
  );
}

void main() {
  group('compareVersions', () {
    test('按段比较数字，1.10.0 大于 1.9.0', () {
      expect(compareVersions('1.10.0', '1.9.0'), 1);
      expect(compareVersions('1.9.0', '1.10.0'), -1);
    });

    test('缺段视为 0，1.0 与 1.0.0 相等', () {
      expect(compareVersions('1.0', '1.0.0'), 0);
      expect(compareVersions('1.0.1', '1.0'), 1);
    });

    test('无法判定时返回 null（任一侧缺失或空）', () {
      expect(compareVersions(null, '1.0.0'), isNull);
      expect(compareVersions('1.0.0', null), isNull);
      expect(compareVersions('  ', '1.0.0'), isNull);
    });

    test('预发布标记视为低于正式版', () {
      expect(compareVersions('1.0.0', '1.0.0-beta'), 1);
      expect(compareVersions('1.0.0-beta', '1.0.0'), -1);
    });
  });

  group('decideUpdate', () {
    test('build 变大即提示更新', () {
      expect(
        decideUpdate(remote: remote(build: '14'), localBuild: '13', localVersion: '1.0.0'),
        UpdateDecision.updateAvailable,
      );
    });

    test('build 相同且版本名相同 → 不提示', () {
      expect(
        decideUpdate(remote: remote(build: '13', version: '1.0.0'), localBuild: '13', localVersion: '1.0.0'),
        UpdateDecision.none,
      );
    });

    test('build 相同但版本名更大 → 提示（同 build 补发过版本名）', () {
      expect(
        decideUpdate(remote: remote(build: '13', version: '1.0.1'), localBuild: '13', localVersion: '1.0.0'),
        UpdateDecision.updateAvailable,
      );
    });

    test('本机 build 读不到时退化为比版本名', () {
      expect(
        decideUpdate(remote: remote(build: '14', version: '1.0.1'), localBuild: null, localVersion: '1.0.0'),
        UpdateDecision.updateAvailable,
      );
    });

    test('本机版本全读不到 → 静默，宁可漏提示也不误报', () {
      expect(
        decideUpdate(remote: remote(), localBuild: null, localVersion: null),
        UpdateDecision.none,
      );
    });

    test('本机 build 更高（用户装了内测版）→ 不提示降级', () {
      expect(
        decideUpdate(remote: remote(build: '13'), localBuild: '99', localVersion: '0.9.0'),
        UpdateDecision.none,
      );
    });

    test('服务端未配置 / 无应用时一律静默', () {
      expect(
        decideUpdate(remote: remote(configured: false), localBuild: '1', localVersion: '1.0.0'),
        UpdateDecision.none,
      );
      expect(
        decideUpdate(remote: remote(available: false), localBuild: '1', localVersion: '1.0.0'),
        UpdateDecision.none,
      );
      expect(
        decideUpdate(remote: null, localBuild: '1', localVersion: '1.0.0'),
        UpdateDecision.none,
      );
    });

    test('build 带小数点时按段比较，13.2 视为比 13.1 新', () {
      // 不能只取第一段：否则 13.2 与 13.1 会被当成同一版，用户永远收不到更新。
      expect(
        decideUpdate(remote: remote(build: '13.2'), localBuild: '13.1', localVersion: '1.0.0'),
        UpdateDecision.updateAvailable,
      );
      expect(
        decideUpdate(remote: remote(build: '14.0'), localBuild: '13.9', localVersion: '1.0.0'),
        UpdateDecision.updateAvailable,
      );
      expect(
        decideUpdate(remote: remote(build: '13.1'), localBuild: '13.2', localVersion: '1.0.0'),
        UpdateDecision.none,
      );
    });

    test('build 含非数字段时退回比版本名，不抛异常', () {
      expect(
        decideUpdate(remote: remote(build: '13-beta', version: '1.0.1'), localBuild: '12', localVersion: '1.0.0'),
        UpdateDecision.updateAvailable,
      );
    });
  });

  group('AppUpdateInfo', () {
    test('解析服务端 JSON', () {
      final info = AppUpdateInfo.tryParse({
        'platform': 'ios',
        'configured': true,
        'available': true,
        'version': '1.0.0',
        'build': '13',
        'installUrl': 'itms-services://?action=download-manifest&url=https://x/y.plist',
        'sizeBytes': 9064558,
      });
      expect(info, isNotNull);
      expect(info!.build, '13');
      expect(info.canInstallDirectly, isTrue);
      // 已经是 itms-services 的原样保留。
      expect(info.installTarget, 'itms-services://?action=download-manifest&url=https://x/y.plist');
      expect(formatBytes(info.sizeBytes), '8.6 MB');
    });

    test('缺 platform 视为无效', () {
      expect(AppUpdateInfo.tryParse({'configured': true}), isNull);
      expect(AppUpdateInfo.tryParse('nope'), isNull);
    });

    test('fir 的 installUrl 是 manifest plist，必须包成 itms-services', () {
      // 这是线上真实返回：Content-Type 是 application/x-plist。
      // 直接打开只会让 Safari 显示 XML 或下载文件，不会安装。
      final info = AppUpdateInfo.tryParse({
        'platform': 'ios',
        'configured': true,
        'available': true,
        'build': '14',
        'installUrl': 'https://download.appmeta.cn/apps/abc/install?download_token=tok&source=update',
      });
      final target = info!.installTarget!;
      expect(target, startsWith('itms-services://?action=download-manifest&url='));
      // 原始地址必须被 URL 编码后作为参数，否则 & 会截断。
      expect(target, contains(Uri.encodeComponent('https://download.appmeta.cn/apps/abc/install')));
      expect(Uri.parse(target).queryParameters['action'], 'download-manifest');
      expect(
        Uri.parse(target).queryParameters['url'],
        'https://download.appmeta.cn/apps/abc/install?download_token=tok&source=update',
      );
    });

    test('只有网页短链时不可安装，绝不退回下载页', () {
      final info = AppUpdateInfo.tryParse({
        'platform': 'ios',
        'configured': true,
        'available': true,
        'build': '13',
        'updateUrl': 'http://fir.xcxwo.com/abc',
      });
      // 网页短链点了只会下载 ipa，留下管不到的文件——所以不给装。
      expect(info!.canInstallDirectly, isFalse);
      expect(info.installTarget, isNull);
      // 但地址仍保留，仅供展示/兜底文案使用。
      expect(info.webPageUrl, 'http://fir.xcxwo.com/abc');
    });
  });
}
