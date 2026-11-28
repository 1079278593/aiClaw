import 'package:aiclaw_mobile/src/api_client.dart';
import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/ui/experts_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 只回答领域面板用到的两个接口。
class _Api extends ApiClient {
  _Api({this.available = const [], this.failPatch = false});

  List<String> available;
  bool failPatch;
  final List<List<String>> patches = [];

  @override
  Future<Map<String, Object?>> getJson(Uri uri, {String token = ''}) async {
    if (uri.path.endsWith('/api/experts')) {
      return {
        'experts': available.map((id) => {'id': id, 'hasIndex': true}).toList(),
      };
    }
    return const {};
  }

  @override
  Future<Map<String, Object?>> sendJson(
    String method,
    Uri uri, {
    String token = '',
    Map<String, Object?>? body,
  }) async {
    if (method == 'PATCH' && uri.path.contains('/api/sessions/')) {
      final experts = (body?['experts'] as List?)?.cast<String>() ?? <String>[];
      if (failPatch) throw ApiException(500, '保存失败');
      patches.add(experts);
      return {'session': {'id': 's1', 'title': '对话', 'experts': experts}};
    }
    return const {};
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> pumpSheet(WidgetTester tester, AppController controller) async {
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: FilledButton(
              onPressed: () => showExpertsSheet(context, controller: controller, sessionId: 's1'),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  // 窄屏最容易挤爆：两个领域的名字加提示行。
  for (final size in const [Size(320, 640), Size(400, 900)]) {
    testWidgets('领域面板在 ${size.width.toInt()} 宽不出溢出', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final controller = AppController(api: _Api(available: ['情感', '理财']))..baseUrl = 'http://x'..token = 't';
      await pumpSheet(tester, controller);

      expect(tester.takeException(), isNull, reason: '窄屏出现布局溢出');
      expect(find.text('情感'), findsOneWidget);
      expect(find.text('理财'), findsOneWidget);
    });
  }

  testWidgets('勾一个立刻保存，第三次勾选被拒绝且不改名单', (tester) async {
    final api = _Api(available: ['情感', '理财', '运动']);
    final controller = AppController(api: api)..baseUrl = 'http://x'..token = 't';
    await pumpSheet(tester, controller);

    await tester.tap(find.text('情感'));
    await tester.pumpAndSettle();
    expect(api.patches.last, ['情感']);

    await tester.tap(find.text('理财'));
    await tester.pumpAndSettle();
    expect(api.patches.last, ['情感', '理财']);

    // 已勾 2 个：再点第三个只提示，不发请求、不自动换掉一个。
    final before = api.patches.length;
    await tester.tap(find.text('运动'));
    await tester.pumpAndSettle();
    expect(api.patches.length, before);
    expect(find.textContaining('最多勾 2 个'), findsOneWidget);
  });

  testWidgets('保存失败时退回上一次成功的名单', (tester) async {
    final api = _Api(available: ['情感'], failPatch: true);
    final controller = AppController(api: api)..baseUrl = 'http://x'..token = 't';
    await pumpSheet(tester, controller);

    await tester.tap(find.text('情感'));
    await tester.pumpAndSettle();

    expect(find.textContaining('已退回上一次的勾选'), findsOneWidget);
    final tile = tester.widget<CheckboxListTile>(find.byType(CheckboxListTile));
    expect(tile.value, isFalse);
  });
}
