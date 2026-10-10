import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/ui/ai_theme.dart';
import 'package:aiclaw_mobile/ui/shell_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('手机使用底部三栏', (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: ShellPage(controller: AppController())));
    await tester.pump();
    expect(find.widgetWithText(NavigationDestination, '聊天'), findsOneWidget);
    expect(find.widgetWithText(NavigationDestination, '文档'), findsOneWidget);
    expect(find.widgetWithText(NavigationDestination, '更多'), findsOneWidget);
  });

  testWidgets('字号不是 16 时主题仍能建出来', (tester) async {
    final controller = AppController()..fontSize = 22;
    await tester.pumpWidget(MaterialApp(
      theme: aiTheme(controller),
      builder: (context, child) => applyFontSize(context, controller, child),
      home: const Scaffold(body: Text('字')),
    ));
    expect(find.text('字'), findsOneWidget);
  });

  testWidgets('宽屏同时放文档阅读和聊天', (tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: ShellPage(controller: AppController())));
    await tester.pump();
    expect(find.text('从左侧打开一篇文档'), findsOneWidget);
    expect(find.text('新建对话'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    final handles = find.byWidgetPredicate(
      (widget) => widget is MouseRegion && widget.cursor == SystemMouseCursors.resizeColumn,
    );
    expect(handles, findsNWidgets(2));
    await tester.drag(handles.first, const Offset(48, 0));
    await tester.pump();
  });
}
