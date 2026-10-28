import 'package:aiclaw_mobile/src/app_controller.dart';
import 'package:aiclaw_mobile/ui/people_list_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('关闭新建对话框时不提前释放输入框', (tester) async {
    await tester.pumpWidget(MaterialApp(home: PeopleListPage(controller: AppController())));
    await tester.pump();

    await tester.tap(find.byIcon(Icons.person_add_alt));
    await tester.pumpAndSettle();
    expect(find.text('称呼'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pumpAndSettle();

    expect(find.text('新建'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
