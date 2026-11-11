/// 「上下文来源」的数据形状。字段对齐服务端 `src/context/sources.ts`。
///
/// 这里只做数据搬运，不做任何排版判断：占比、超限这些**已经由服务端算好**，
/// 客户端自己再算一遍就会出现「同一块内容两个数字」——
/// 正是这个接口存在的理由（见服务端 `sources.ts` 开头的两条硬约束）。
class ContextSource {
  const ContextSource({
    required this.id,
    required this.label,
    required this.file,
    required this.role,
    required this.always,
    required this.editable,
    required this.readonlyReason,
    required this.content,
    required this.editText,
    required this.tokens,
    required this.max,
    required this.maxBytes,
    required this.overLimit,
    required this.bytes,
    required this.entries,
  });

  final String id;
  final String label;

  /// 相对数据根的路径，展示用。
  final String file;
  final String role;

  /// 是否无条件每轮注入。
  final bool always;
  final bool editable;
  final String? readonlyReason;

  /// 磁盘上的原始内容。
  final String content;

  /// 编辑框应显示的文本。记忆层这里是磁盘原文，`content` 是注入形态，
  /// 两者**不能混用**：把注入形态写回磁盘会让包装层层嵌套。
  final String editText;

  final int tokens;
  final int? max;
  final int? maxBytes;

  /// 超限的块会被整块丢弃，不是截断。
  final bool overLimit;
  final int bytes;

  /// 条目数（仅多条目来源）。
  final int? entries;

  static ContextSource? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    if (id is! String || id.isEmpty) return null;
    final content = raw['content'];
    final editText = raw['editText'];
    return ContextSource(
      id: id,
      label: _str(raw['label']) ?? id,
      file: _str(raw['file']) ?? '',
      role: _str(raw['role']) ?? '',
      always: raw['always'] == true,
      editable: raw['editable'] == true,
      readonlyReason: _str(raw['readonlyReason']),
      content: content is String ? content : '',
      editText: editText is String ? editText : (content is String ? content : ''),
      tokens: _int(raw['tokens']),
      max: _intOrNull(raw['max']),
      maxBytes: _intOrNull(raw['maxBytes']),
      overLimit: raw['overLimit'] == true,
      bytes: _int(raw['bytes']),
      entries: _intOrNull(raw['entries']),
    );
  }
}

class ContextOverview {
  const ContextOverview({
    required this.sources,
    required this.totalTokens,
    required this.totalMax,
    required this.injectRootIndex,
    required this.injectDistillMap,
  });

  final List<ContextSource> sources;

  /// 每轮固定成本：只累加 `always` 的块。
  final int totalTokens;

  /// 固定块上限合计。这是「最坏能吃掉多少」，不等于模型窗口。
  final int totalMax;
  final bool injectRootIndex;
  final bool injectDistillMap;

  static ContextOverview? tryParse(Map<String, Object?> raw) {
    final list = raw['sources'];
    if (list is! List) return null;
    final switches = raw['switches'];
    final map = switches is Map ? switches : const {};
    return ContextOverview(
      sources: [
        for (final item in list) ?ContextSource.tryParse(item),
      ],
      totalTokens: _int(raw['totalTokens']),
      totalMax: _int(raw['totalMax']),
      injectRootIndex: map['injectRootIndex'] == true,
      injectDistillMap: map['injectDistillMap'] == true,
    );
  }
}

/// 一次 PUT 的结果。服务端逐条独立处理：一条失败不阻塞其他条。
class ContextSaveResult {
  const ContextSaveResult({
    required this.saved,
    required this.failed,
    required this.overview,
  });

  final List<String> saved;
  final List<({String id, String error})> failed;

  /// 保存后重新统计的概览。部分失败时也会带回来，便于界面立即反映已写入的块。
  final ContextOverview? overview;

  bool get ok => failed.isEmpty;

  static ContextSaveResult from(Map<String, Object?> raw) {
    final saved = raw['saved'];
    final failed = raw['failed'];
    final overview = raw['overview'];
    return ContextSaveResult(
      saved: [
        for (final item in saved is List ? saved : const [])
          if (item is String) item,
      ],
      failed: [
        for (final item in failed is List ? failed : const [])
          if (item is Map)
            (
              id: '${item['id'] ?? ''}',
              error: '${item['error'] ?? '保存失败'}',
            ),
      ],
      overview: overview is Map
          ? ContextOverview.tryParse(Map<String, Object?>.from(overview))
          : null,
    );
  }
}

String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;

int _int(Object? value) => value is num ? value.toInt() : 0;

int? _intOrNull(Object? value) => value is num ? value.toInt() : null;
