import 'package:aiclaw_mobile/ui/reflection_list_rows.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('文件夹行：左侧图标与名称、右侧数字与箭头', (tester) async {
    await tester.pumpWidget(
      _wrap(
        ReflectionFolderRow(
          name: '读书笔记',
          noteCount: 12,
          onTap: () {},
        ),
      ),
    );

    expect(find.text('读书笔记'), findsOneWidget);
    expect(find.text('12'), findsOneWidget);
    expect(find.byIcon(Icons.folder), findsOneWidget);
    expect(find.byIcon(Icons.chevron_right), findsOneWidget);
    // 没有子文件夹时不显示展开箭头
    expect(find.byIcon(Icons.arrow_right), findsNothing);

    // 名称在左，数字在右
    final nameX = tester.getCenter(find.text('读书笔记')).dx;
    final countX = tester.getCenter(find.text('12')).dx;
    final chevronX = tester.getCenter(find.byIcon(Icons.chevron_right)).dx;
    expect(nameX, lessThan(countX));
    expect(countX, lessThan(chevronX));
  });

  testWidgets('有子文件夹时行首出现展开箭头，点数字区不误触展开', (tester) async {
    var toggled = 0;
    var opened = 0;
    await tester.pumpWidget(
      _wrap(
        ReflectionFolderRow(
          name: '主题',
          noteCount: 3,
          expandable: true,
          onToggleExpand: () => toggled += 1,
          onTap: () => opened += 1,
        ),
      ),
    );

    expect(find.byIcon(Icons.arrow_right), findsOneWidget);
    await tester.tap(find.byIcon(Icons.arrow_right));
    expect(toggled, 1);
    expect(opened, 0);

    await tester.tap(find.text('主题'));
    expect(opened, 1);
  });

  testWidgets('笔记行：标题一行，摘要一行且只占一行', (tester) async {
    final longText = '时间 14:24  ${'这是一段很长的摘要，' * 20}';
    await tester.pumpWidget(
      _wrap(
        SizedBox(
          width: 320,
          child: ReflectionNoteRow(
            title: '一个非常长的标题用来测试是否会被截断成一行而不是换行显示',
            preview: longText,
            onTap: () {},
          ),
        ),
      ),
    );

    final title = tester.widget<Text>(find.textContaining('一个非常长的标题'));
    final preview = tester.widget<Text>(find.textContaining('这是一段很长的摘要'));
    expect(title.maxLines, 1);
    expect(title.overflow, TextOverflow.ellipsis);
    expect(preview.maxLines, 1);
    expect(preview.overflow, TextOverflow.ellipsis);
    expect(preview.style!.fontSize, lessThan(16));

    // 标题在上，摘要在下
    final titleY = tester.getCenter(find.textContaining('一个非常长的标题')).dy;
    final previewY = tester.getCenter(find.textContaining('这是一段很长的摘要')).dy;
    expect(titleY, lessThan(previewY));
  });
}
