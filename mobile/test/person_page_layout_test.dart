import 'package:aiclaw_mobile/src/api_client.dart';
import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/ui/person_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 只回答人物页进入时读到的几处接口。
class _Api extends ApiClient {
  /// 每次拉详情时递增，用来模拟「第一次还在整理、第二次跑完了」。
  int detailCalls = 0;
  Map<String, Object?>? lastOrganize;
  bool organizing = false;

  @override
  Future<Map<String, Object?>> getJson(Uri uri, {String token = ''}) async {
    if (uri.path.endsWith('/api/app-state')) {
      return {'autoOrganizeEffective': true, 'recentModels': <Object?>[]};
    }
    if (uri.path.endsWith('/sessions')) {
      return {
        'sessions': [
          {'id': 's1', 'title': '很长的分析会话名称用来挤压窄屏布局', 'updatedAt': '2026-01-01T00:00:00.000Z'},
        ],
      };
    }
    if (uri.path.endsWith('/entries')) {
      return {'entries': <Object?>[], 'hasMore': false};
    }
    if (uri.path.contains('/api/people/')) {
      detailCalls += 1;
      return {
        'person': {
          'id': 'p1',
          'name': '阿宁',
          'nicknames': <Object?>[],
          'shortNames': <Object?>[],
          if (lastOrganize != null) 'lastOrganize': lastOrganize,
        },
        'profile': '档案',
        'digest': '简报',
        'current': '当前判断',
        'organizing': organizing,
      };
    }
    return const {};
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // 人物页分析条现在是两行（会话选择 + 自动整理开关），窄屏最容易挤爆。
  for (final size in const [Size(320, 640), Size(400, 900)]) {
    testWidgets('人物页分析条在 ${size.width.toInt()} 宽不出溢出', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final controller = AppController(api: _Api())..baseUrl = 'http://x'..token = 't';
      await tester.pumpWidget(MaterialApp(
        home: PersonPage(controller: controller, personId: 'p1', initialName: '阿宁'),
      ));
      await tester.pumpAndSettle();

      final error = tester.takeException();
      expect(error, isNull, reason: '窄屏出现布局溢出：$error');
      // 开关要看得到，并且显示当前状态。
      expect(find.text('自动整理'), findsOneWidget);
      expect(find.text('开'), findsOneWidget);
      // 整理状态也要在窄屏上留一行，不能因为没有原文就消失。
      expect(find.text('还没整理过'), findsOneWidget);
    });
  }

  testWidgets('整理失败时那一行说清原因，且不溢出', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _Api()
      ..lastOrganize = {
        'at': '2026-05-01T02:03:00.000Z',
        'status': 'failed',
        'message': '整理用的模型没有配置',
      };
    final controller = AppController(api: api)..baseUrl = 'http://x'..token = 't';
    await tester.pumpWidget(MaterialApp(
      home: PersonPage(controller: controller, personId: 'p1', initialName: '阿宁'),
    ));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.textContaining('上次整理失败'), findsOneWidget);
    expect(find.textContaining('整理用的模型没有配置'), findsOneWidget);
  });

  testWidgets('后台整理在跑时显示「整理中…」，跑完自动换成结局', (tester) async {
    tester.view.physicalSize = const Size(400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _Api()..organizing = true;
    final controller = AppController(api: api)..baseUrl = 'http://x'..token = 't';
    await tester.pumpWidget(MaterialApp(
      home: PersonPage(controller: controller, personId: 'p1', initialName: '阿宁'),
    ));
    await tester.pumpAndSettle();

    // `chatEnd` 一到就拉，此刻简报和当前判断还是旧的：先说清「在跑」。
    expect(find.text('整理中…'), findsOneWidget);

    // 服务端说跑完了，页面自己再拉一次，不该让人手动刷新。
    api
      ..organizing = false
      ..lastOrganize = {'at': '2026-05-01T02:03:00.000Z', 'status': 'ok'};
    await tester.pump(const Duration(milliseconds: 1600));
    await tester.pumpAndSettle();

    expect(find.text('整理中…'), findsNothing);
    expect(find.textContaining('整理于'), findsOneWidget);
  });
}
