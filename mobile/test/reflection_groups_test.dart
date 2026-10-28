import 'package:aiclaw_mobile/src/reflection_groups.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final now = DateTime.utc(2026, 10, 28, 4); // 东八区 2026-10-28 12:00

  test('近 30 天分成互不交叉的组，更早按年份', () {
    expect(reflectionGroupLabel('2026-10-28T02:00:00.000Z', now), '今天');
    expect(reflectionGroupLabel('2026-10-27T10:00:00.000Z', now), '昨天');
    expect(reflectionGroupLabel('2026-10-24T02:00:00.000Z', now), '前 7 天');
    expect(reflectionGroupLabel('2026-10-10T02:00:00.000Z', now), '前 30 天');
    expect(reflectionGroupLabel('2024-01-01T00:00:00.000Z', now), '2024');
  });

  test('分组顺序是今天到更早的年份', () {
    final labels = ['2024', '前 30 天', '今天', '2025', '昨天'];
    labels.sort(
      (a, b) => reflectionGroupRank(a).compareTo(reflectionGroupRank(b)),
    );
    expect(labels, ['今天', '昨天', '前 30 天', '2025', '2024']);
  });
}
