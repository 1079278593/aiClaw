import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/src/api_client.dart';
import 'package:aiclaw_mobile/ui/reflections_chat_sheet.dart';
import 'package:aiclaw_mobile/ui/reflections_list_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 只实现 pending 相关读写的假客户端。
class _FakeApi extends ApiClient {
  int applyAllCalls = 0;

  @override
  Future<Map<String, Object?>> getJson(Uri uri, {String token = ''}) async {
    if (uri.path.endsWith('/api/pending')) {
      return {
        'items': [
          {'id': 'p1', 'target': 'reflections/a.md', 'summary': '改标题', 'changeType': 'update'},
          {'id': 'p2', 'target': 'reflections/b.md', 'summary': '补正文', 'changeType': 'update'},
        ],
        'badge': 2,
      };
    }
    return const {};
  }

  @override
  Future<Map<String, Object?>> sendJson(
    String method,
    Uri uri, {
    String token = '',
    Object? body,
  }) async {
    if (uri.path.endsWith('/api/pending/apply-all')) {
      applyAllCalls += 1;
      return {'items': [], 'applied': 1, 'stale': 1, 'conflict': 0, 'failed': 0, 'ok': false};
    }
    return const {};
  }
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('心得首页底部有一个横贯整宽的对话入口', (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final controller = AppController();
    await tester.pumpWidget(MaterialApp(
      home: ReflectionsListPage(controller: controller),
    ));
    await tester.pump();

    // 未连接时列表走错误分支，但入口独立于列表，仍要在。
    expect(find.text('心得对话'), findsOneWidget);
    final button = tester.getRect(find.widgetWithText(FilledButton, '心得对话'));
    expect(button.left, 16);
    expect(button.right, 400 - 16);
    // bottom: 12 相对 body，而 tabbar 是 shell 层，位置天然在其上方。
    final body = tester.getRect(find.byType(Stack).first);
    expect(body.bottom - button.bottom, reflectionsEntryBottomInset);
  });

  testWidgets('有待应用时入口带角标数字', (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final controller = AppController()..pendingBadge = 3;
    await tester.pumpWidget(MaterialApp(
      home: ReflectionsListPage(controller: controller),
    ));
    await tester.pump();
    expect(find.text('心得对话 · 待应用 3'), findsOneWidget);
  });

  testWidgets('待应用列表有「全部应用」，逐条报告结果而不是只报成功', (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _FakeApi();
    final controller = AppController(api: api)..baseUrl = 'http://x';
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showPendingSheet(context, controller),
            child: const Text('打开待应用'),
          ),
        ),
      ),
    ));

    await tester.tap(find.text('打开待应用'));
    await tester.pumpAndSettle();

    expect(find.text('全部应用（2）'), findsOneWidget);

    await tester.tap(find.text('全部应用（2）'));
    await tester.pumpAndSettle();
    // 二次确认后才真正提交。
    expect(find.text('全部应用 2 条改动？'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '全部应用'));
    await tester.pumpAndSettle();

    // 一条成、一条失效：必须分别说出来。
    expect(find.textContaining('已应用 1 条'), findsOneWidget);
    expect(find.textContaining('1 条已失效'), findsOneWidget);
  });

  testWidgets('心得对话改为整页：未连接时只提示，不进页面', (tester) async {
    tester.view.physicalSize = const Size(400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final controller = AppController();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showReflectionsChat(context, controller),
            child: const Text('打开'),
          ),
        ),
      ),
    ));

    // 未连接时拿不到会话，应该只弹提示而不是崩，也不应压进一个页面。
    await tester.tap(find.text('打开'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('心得对话'), findsNothing);
  });
}
