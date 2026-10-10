import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/ui/shell_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
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
  });
}
