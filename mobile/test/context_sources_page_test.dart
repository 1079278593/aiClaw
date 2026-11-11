import 'package:aiclaw_mobile/src/api_client.dart';
import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/src/context_sources.dart';
import 'package:aiclaw_mobile/ui/context_sources_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 只实现上下文来源读写的假客户端。
class _FakeApi extends ApiClient {
  _FakeApi({this.saveStatus = 200, this.failFirst = false});

  final int saveStatus;
  final bool failFirst;
  Map<String, String> lastUpdates = {};

  Map<String, Object?> _source(String id, String label, String text, {bool editable = true}) => {
        'id': id,
        'label': label,
        'file': '$id.md',
        'role': '$label 的角色',
        'always': true,
        'editable': editable,
        'content': text,
        'editText': text,
        'tokens': 10,
        'max': 1000,
        'overLimit': false,
        'bytes': text.length,
      };

  @override
  Future<Map<String, Object?>> getJson(Uri uri, {String token = ''}) async {
    if (uri.path.endsWith('/api/context/sources')) {
      return {
        'sources': [
          _source('constitution', '系统提示词（宪法）', '你是助手。'),
          _source('user', '用户画像', '喜欢简洁。'),
          _source('rootIndex', '心得根索引', 'a.md', editable: false),
        ],
        'totalTokens': 30,
        'totalMax': 3000,
        'switches': {'injectRootIndex': false, 'injectDistillMap': false},
      };
    }
    return const {};
  }

  @override
  Future<ApiResult> sendJsonAllowError(
    String method,
    Uri uri, {
    String token = '',
    Map<String, Object?>? body,
  }) async {
    if (uri.path.endsWith('/api/context/sources')) {
      final updates = body?['updates'];
      if (updates is List) {
        for (final item in updates) {
          if (item is Map) {
            lastUpdates['${item['id']}'] = '${item['content']}';
          }
        }
      }
      // 复刻服务端的「部分成功」：400 里同时给出 saved / failed / overview。
      return ApiResult(saveStatus, {
        'saved': failFirst ? ['user'] : lastUpdates.keys.toList(),
        'failed': failFirst
            ? [
                {'id': 'constitution', 'error': '内容超出该块上限（1200 / 900 token）'},
              ]
            : const [],
        'overview': {
          'sources': [
            _source('constitution', '系统提示词（宪法）', lastUpdates['constitution'] ?? '你是助手。'),
            _source('user', '用户画像', lastUpdates['user'] ?? '喜欢简洁。'),
          ],
          'totalTokens': 20,
          'totalMax': 2000,
          'switches': {'injectRootIndex': false, 'injectDistillMap': false},
        },
      });
    }
    return ApiResult(200, const {});
  }
}

Future<void> _open(WidgetTester tester, AppController controller) async {
  tester.view.physicalSize = const Size(400, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(home: ContextSourcesPage(controller: controller)));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('上下文来源解析：非法条目跳过，不因一条坏数据整块失败', () {
    final overview = ContextOverview.tryParse({
      'sources': [
        {'id': 'a', 'label': 'A', 'content': 'x'},
        {'label': '没有 id'},
        'not a map',
      ],
      'totalTokens': 5,
      'totalMax': 100,
      'switches': {'injectRootIndex': true},
    });
    expect(overview, isNotNull);
    expect(overview!.sources.length, 1);
    expect(overview.sources.first.id, 'a');
    expect(overview.injectRootIndex, isTrue);
    expect(overview.injectDistillMap, isFalse);
  });

  test('保存结果解析：failed 逐条保留，ok 反映是否全部成功', () {
    final result = ContextSaveResult.from({
      'saved': ['user'],
      'failed': [
        {'id': 'constitution', 'error': '超限'},
      ],
    });
    expect(result.saved, ['user']);
    expect(result.failed.single.id, 'constitution');
    expect(result.failed.single.error, '超限');
    expect(result.ok, isFalse);
  });

  testWidgets('整页列出各来源，「确认修改」在没改动时不可点', (tester) async {
    final controller = AppController(api: _FakeApi())..baseUrl = 'http://x'..token = 't';
    await _open(tester, controller);

    expect(find.text('系统提示词（宪法）'), findsOneWidget);
    expect(find.text('用户画像'), findsOneWidget);
    expect(find.text('每轮必带'), findsWidgets);
    expect(find.text('0 块未保存'), findsNothing);
    final save = tester.widget<FilledButton>(find.widgetWithText(FilledButton, '确认修改'));
    expect(save.onPressed, isNull);

    // 只读块在列表靠后，先滚到它再断言（ListView 懒构建，视口外不会存在）。
    await tester.scrollUntilVisible(
      find.textContaining('此处不可编辑'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.textContaining('此处不可编辑'), findsOneWidget);
  });

  testWidgets('改一块后出现未保存提示，放弃会还原编辑框', (tester) async {
    final controller = AppController(api: _FakeApi())..baseUrl = 'http://x'..token = 't';
    await _open(tester, controller);

    await tester.enterText(find.byType(TextField).first, '你是更严格的助手。');
    await tester.pumpAndSettle();
    expect(find.textContaining('1 块未保存'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, '放弃'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '放弃'));
    await tester.pumpAndSettle();

    expect(find.textContaining('块未保存'), findsNothing);
    // 编辑框回到磁盘内容，而不是留着刚输入的草稿。
    final field = tester.widget<TextField>(find.byType(TextField).first);
    expect(field.controller?.text, '你是助手。');
  });

  testWidgets('部分失败要逐条说出哪一块、为什么，而不是只报「保存失败」', (tester) async {
    final api = _FakeApi(saveStatus: 400, failFirst: true);
    final controller = AppController(api: api)..baseUrl = 'http://x'..token = 't';
    await _open(tester, controller);

    await tester.enterText(find.byType(TextField).first, '改过的宪法');
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, '确认修改'));
    await tester.pumpAndSettle();
    // 二次确认：对话框里的按钮是后渲染的那一个。
    await tester.tap(find.widgetWithText(FilledButton, '确认修改').last);
    await tester.pumpAndSettle();

    expect(api.lastUpdates['constitution'], '改过的宪法');
    // 关键：具体原因必须可见（不是汇总成一句「保存失败」）。
    expect(
      find.textContaining('constitution: 内容超出该块上限'),
      findsOneWidget,
    );
  });
}
