import 'package:aiclaw_mobile/ui/person_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('识别接在已有文字后面，光标在末尾', () {
    final value = speechFieldValue('已有', '新的一句');
    expect(value.text, '已有新的一句');
    expect(value.selection.extentOffset, value.text.length);
  });

  test('这一轮还没有字时保持原文', () {
    final value = speechFieldValue('已有', '');
    expect(value.text, '已有');
    expect(value.selection.extentOffset, '已有'.length);
  });

  test('安静时圆不放大，说话时变大', () {
    expect(speechLevel(double.negativeInfinity), 0);
    expect(speechLevel(-50), 0);
    expect(speechLevel(-20), closeTo(0.6, 0.001));
    expect(speechLevel(-2), 0);
    expect(speechLevel(10), 1);
  });

  testWidgets('超过可见行数时滚到最新一行', (tester) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    final scroll = ScrollController();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    addTearDown(scroll.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TextField(
            controller: controller,
            focusNode: focus,
            scrollController: scroll,
            minLines: 1,
            maxLines: 5,
          ),
        ),
      ),
    );
    await tester.tap(find.byType(TextField));
    await tester.pump();

    final value = speechFieldValue(
      '',
      List.filled(12, '这是一句识别出来的话').join('\n'),
    );
    controller.value = value;
    await tester.pump();
    expect(scroll.position.pixels, 0);

    revealSpeechTail(scroll);
    await tester.pump();
    expect(scroll.position.pixels, closeTo(scroll.position.maxScrollExtent, 1));
  });
}
