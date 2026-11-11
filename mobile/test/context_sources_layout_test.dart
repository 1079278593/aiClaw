import 'package:aiclaw_mobile/src/api_client.dart';
import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/ui/context_sources_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 布局回归：窄屏 + 大字号是最容易溢出的组合，单独盯住。
class _Api extends ApiClient {
  @override
  Future<Map<String, Object?>> getJson(Uri uri, {String token = ''}) async {
    if (uri.path.endsWith('/api/context/sources')) {
      return {
        'sources': [
          {
            'id': 'constitution',
            'label': '系统提示词（宪法）',
            'file': 'agents/main/AGENT.md',
            'role': '身份与行为策略。它被丢掉时对话会失准，所以预算里最后才丢',
            'always': true,
            'editable': true,
            'content': '你是助手。',
            'editText': '你是助手。',
            'tokens': 123456,
            'max': 200000,
            'overLimit': true,
            'bytes': 999999,
            'entries': 3,
          },
        ],
        'totalTokens': 123456,
        'totalMax': 200000,
        'switches': {'injectRootIndex': true, 'injectDistillMap': true},
      };
    }
    return const {};
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final size in const [Size(320, 640), Size(400, 900)]) {
    testWidgets('上下文来源在 ${size.width.toInt()} 宽不出溢出', (tester) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final controller = AppController(api: _Api())..baseUrl = 'http://x'..token = 't';
      await tester.pumpWidget(MaterialApp(home: ContextSourcesPage(controller: controller)));
      await tester.pumpAndSettle();

      // 溢出会以 FlutterError 形式抛出，这里断言没有异常。
      final error = tester.takeException();
      expect(error, isNull, reason: '窄屏出现布局溢出：$error');
      // 超限必须显式告警，不能只靠进度条颜色表达。
      expect(find.text('超限会被整块丢弃'), findsOneWidget);
      // 千分位要真的加出来，否则 123456 很难读。
      expect(find.textContaining('123,456'), findsWidgets);
    });
  }
}
