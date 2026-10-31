/// 心得笔记列表的日期分组。依据编辑时间，日期按东八区，组与组不交叉。
String reflectionGroupLabel(String? iso, DateTime now) {
  final instant = DateTime.tryParse(iso ?? '');
  if (instant == null) return '更早';
  final day = _shanghaiDate(instant);
  final today = _shanghaiDate(now);
  final delta = today.difference(day).inDays;
  if (delta <= 0) return '今天';
  if (delta == 1) return '昨天';
  if (delta <= 7) return '前 7 天';
  if (delta <= 30) return '前 30 天';
  return '${_shanghai(instant).year}';
}

int reflectionGroupRank(String label) {
  switch (label) {
    case '今天':
      return 0;
    case '昨天':
      return 1;
    case '前 7 天':
      return 2;
    case '前 30 天':
      return 3;
    default:
      final year = int.tryParse(label);
      if (year == null) return 100000;
      return 10000 - year;
  }
}

/// 笔记行第二行的时间前缀（对齐苹果备忘录：今天给时刻，本年给月日，跨年给年月日）。
String reflectionRowTimeLabel(String? iso, DateTime now) {
  final instant = DateTime.tryParse(iso ?? '');
  if (instant == null) return '';
  final at = _shanghai(instant);
  final today = _shanghaiDate(now);
  final day = DateTime.utc(at.year, at.month, at.day);
  final delta = today.difference(day).inDays;
  if (delta <= 0) {
    final hh = at.hour.toString().padLeft(2, '0');
    final mm = at.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }
  if (delta == 1) return '昨天';
  if (at.year == today.year) return '${at.month}月${at.day}日';
  return '${at.year}年${at.month}月${at.day}日';
}

DateTime _shanghai(DateTime instant) =>
    instant.toUtc().add(const Duration(hours: 8));

DateTime _shanghaiDate(DateTime instant) {
  final local = _shanghai(instant);
  return DateTime.utc(local.year, local.month, local.day);
}
