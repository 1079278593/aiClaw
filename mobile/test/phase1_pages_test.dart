import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/src/chat_models.dart';
import 'package:aiclaw_mobile/ui/chat_page.dart';
import 'package:aiclaw_mobile/ui/connect_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('连接页收集地址和令牌', (tester) async {
    final controller = AppController();
    await tester.pumpWidget(MaterialApp(
      home: ConnectPage(controller: controller, initialError: '凭证无效'),
    ));
    expect(find.text('连接 aiClaw'), findsOneWidget);
    expect(find.text('凭证无效'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '连接'), findsOneWidget);
  });

  testWidgets('聊天页在生成中把发送换成取消，并展开推理和工具', (tester) async {
    final controller = AppController();
    controller.machine.selectSession('s1');
    final runtime = controller.machine.runtimeOf('s1');
    runtime.isStreaming = true;
    runtime.messages.add(DisplayMessage(
      id: 'a1',
      role: 'assistant',
      text: '**正文**',
      reasoning: '先想一下',
      tools: [
        ToolBlock(callId: 'c1', name: 'read', arguments: '{}', result: 'ok'),
      ],
    ));

    await tester.pumpWidget(MaterialApp(
      home: ChatPage(controller: controller, sessionId: 's1'),
    ));
    expect(find.text('先想一下'), findsOneWidget);
    expect(find.text('read'), findsOneWidget);
    expect(find.text('ok'), findsOneWidget);
    expect(find.byIcon(Icons.stop), findsOneWidget);
    expect(find.byIcon(Icons.send), findsNothing);
  });
}
