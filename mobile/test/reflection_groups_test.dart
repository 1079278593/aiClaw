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

  group('笔记行的时间前缀', () {
    // 全部按东八区算：UTC 时间 +8 小时即本地时间。
    final at = DateTime.utc(2026, 10, 31, 6); // 北京 2026-10-31 14:00

    test('今天显示时刻', () {
      expect(reflectionRowTimeLabel('2026-10-31T05:32:00.000Z', at), '13:32');
      expect(reflectionRowTimeLabel('2026-10-30T16:05:00.000Z', at), '00:05');
    });

    test('昨天给「昨天」，本年内给月日，跨年给年月日', () {
      expect(reflectionRowTimeLabel('2026-10-30T03:00:00.000Z', at), '昨天');
      expect(reflectionRowTimeLabel('2026-10-20T03:00:00.000Z', at), '10月20日');
      expect(
        reflectionRowTimeLabel('2025-12-31T03:00:00.000Z', at),
        '2025年12月31日',
      );
    });

    test('解析不了时返回空串，交给摘要占位', () {
      expect(reflectionRowTimeLabel('', at), '');
      expect(reflectionRowTimeLabel('不是时间', at), '');
      expect(reflectionRowTimeLabel(null, at), '');
    });

    test('和分组标签用同一套东八区日期', () {
      final lateNight = DateTime.utc(2026, 10, 22, 16, 30); // 北京 10-23 00:30
      expect(reflectionGroupLabel(lateNight.toIso8601String(), at), '前 30 天');
      expect(reflectionRowTimeLabel(lateNight.toIso8601String(), at), '10月23日');
    });
  });
}
