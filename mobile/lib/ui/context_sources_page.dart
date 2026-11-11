import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import '../src/context_sources.dart';

/// 打开「上下文来源」。
///
/// 做成整页而不是底部弹层：记忆层正文往往是十几行，
/// 弹层键盘一弹就只剩两三行可见，改起来很难受。
Future<void> showContextSourcesPage(
  BuildContext context,
  AppController controller,
) async {
  await Navigator.of(context).push(MaterialPageRoute<void>(
    builder: (_) => ContextSourcesPage(controller: controller),
  ));
}

class ContextSourcesPage extends StatefulWidget {
  const ContextSourcesPage({super.key, required this.controller});

  final AppController controller;

  @override
  State<ContextSourcesPage> createState() => _ContextSourcesPageState();
}

class _ContextSourcesPageState extends State<ContextSourcesPage> {
  ContextOverview? _overview;
  Object? _error;
  var _loading = true;
  var _saving = false;
  String? _status;

  /// 当前编辑中的内容，key 为 source id。与 `editText` 比较判断是否改动。
  final Map<String, String> _drafts = {};

  /// 递增就让所有编辑框的 key 变一次，从而丢掉旧文本回到磁盘内容。
  var _editorEpoch = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final overview = await widget.controller.loadContextSources();
      if (!mounted) return;
      setState(() {
        _overview = overview;
        _drafts.clear();
        _loading = false;
        _status = null;
      });
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  void _edit(ContextSource source, String value) {
    final original = source.editText;
    setState(() {
      if (value == original) {
        _drafts.remove(source.id);
      } else {
        _drafts[source.id] = value;
      }
      _status = null;
    });
  }

  Future<void> _discard() async {
    if (_drafts.isEmpty) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('放弃改动？'),
        content: Text('${_drafts.length} 个内容块会还原成磁盘上的内容。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('继续编辑'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('放弃'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    // 递增 epoch 会让所有编辑框的 key 变一次，从而丢掉旧文本回到快照内容。
    setState(() {
      _drafts.clear();
      _status = null;
      _editorEpoch += 1;
    });
  }

  Future<void> _save() async {
    if (_saving || _drafts.isEmpty) return;
    final byId = {
      for (final source in _overview?.sources ?? const <ContextSource>[]) source.id: source,
    };
    final names = [
      for (final id in _drafts.keys) byId[id]?.label ?? id,
    ];

    // 二次确认：这几块内容下一条消息就生效，一次失手会直接改变 Agent 的行为。
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('写入这些内容块？'),
        content: Text('${names.join('、')}\n\n下一条消息起生效。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('确认修改'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    setState(() {
      _saving = true;
      _status = '正在保存…';
    });
    try {
      final result = await widget.controller.saveContextSources(_drafts);
      if (!mounted) return;
      if (result.overview != null) {
        setState(() {
          _overview = result.overview;
          // 部分成功时也要清草稿：已写入的块内容变了，留着旧草稿会误导。
          _drafts.clear();
        });
      }
      setState(() {
        if (result.ok) {
          _status = '已保存。下一条消息起生效。';
        } else {
          // 逐条说清哪一块没成、为什么，不要汇总成一句「保存失败」。
          _status = result.failed
              .map((item) => '${item.id}: ${item.error}')
              .join('\n');
        }
      });
      if (result.ok) setState(() => _editorEpoch += 1);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _status = error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final overview = _overview;
    return PopScope(
      canPop: _drafts.isEmpty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        // 有未确认的改动时先问，避免返回键无声丢掉编辑内容。
        final ok = await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            title: const Text('放弃未保存的改动？'),
            content: Text('${_drafts.length} 个内容块还没有写入磁盘。'),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: const Text('继续编辑'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('放弃'),
              ),
            ],
          ),
        );
        if (ok == true && context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            overview == null
                ? '上下文来源'
                : '上下文来源 · ${overview.sources.length} 块',
          ),
          actions: [
            IconButton(
              tooltip: '重新读取',
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: Column(
          children: [
            if (_loading)
              const LinearProgressIndicator()
            else if (overview != null)
              _summary(overview),
            if (_status != null)
              _statusBar(context),
            Expanded(
              child: _loading && overview == null
                  ? const SizedBox.shrink()
                  : _error != null
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(_error.toString(), textAlign: TextAlign.center),
                          ),
                        )
                      : ListView(
                          padding: const EdgeInsets.fromLTRB(12, 0, 12, 96),
                          children: [
                            for (final source in overview?.sources ?? const <ContextSource>[])
                              _SourceCard(
                                key: ValueKey('${source.id}-$_editorEpoch'),
                                source: source,
                                draft: _drafts[source.id],
                                onChanged: (value) => _edit(source, value),
                              ),
                          ],
                        ),
            ),
          ],
        ),
        bottomNavigationBar: _bottomBar(),
      ),
    );
  }

  Widget _summary(ContextOverview overview) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = [
      if (overview.injectRootIndex) '根索引',
      if (overview.injectDistillMap) '蒸馏地图',
    ];
    final percent = overview.totalMax > 0
        ? (overview.totalTokens / overview.totalMax).clamp(0.0, 1.0)
        : 0.0;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                _formatTokens(overview.totalTokens),
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
              ),
              const SizedBox(width: 6),
              // Flexible：窄屏上 320 宽时，这个说明文字会把整行顶出去。
              Flexible(
                child: Text(
                  'token / 每轮固定成本',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: scheme.outline),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: percent,
              minHeight: 6,
              backgroundColor: scheme.surfaceContainerHighest,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            '上限合计 ${_formatTokens(overview.totalMax)} token'
            '（各块独立上限之和，不等于模型窗口）。'
            '${enabled.isEmpty ? "根索引与蒸馏地图当前关闭，未计入成本。" : "已开启：${enabled.join("、")}。"}',
            style: TextStyle(fontSize: 12, color: scheme.outline, height: 1.4),
          ),
        ],
      ),
    );
  }

  Widget _statusBar(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        _status!,
        style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant),
      ),
    );
  }

  Widget _bottomBar() {
    final scheme = Theme.of(context).colorScheme;
    final dirty = _drafts.isNotEmpty;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Row(
          children: [
            if (dirty)
              // Flexible + 省略号：窄屏（320 宽）下这行文字会把右侧按钮挤出去。
              Flexible(
                child: Text(
                  '${_drafts.length} 块未保存',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: scheme.outline),
                ),
              ),
            const Spacer(),
            if (dirty)
              TextButton(
                onPressed: _saving ? null : _discard,
                child: const Text('放弃'),
              ),
            const SizedBox(width: 4),
            FilledButton(
              // 没有改动就禁用：避免空提交，与服务端「空更新是前端 bug」的判断一致。
              onPressed: dirty && !_saving ? _save : null,
              child: Text(_saving ? '保存中…' : '确认修改'),
            ),
          ],
        ),
      ),
    );
  }
}

class _SourceCard extends StatelessWidget {
  const _SourceCard({
    super.key,
    required this.source,
    required this.draft,
    required this.onChanged,
  });

  final ContextSource source;
  final String? draft;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final changed = draft != null;
    final percent = source.max != null && source.max! > 0
        ? (source.tokens / source.max!).clamp(0.0, 1.0)
        : 0.0;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    source.label,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                if (changed)
                  _Badge(text: '未保存', color: scheme.tertiaryContainer, on: scheme.onTertiaryContainer),
              ],
            ),
            if (source.file.isNotEmpty)
              Text(
                source.file,
                style: TextStyle(fontSize: 11, color: scheme.outline, fontFamily: 'monospace'),
              ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                _Badge(
                  text: source.always ? '每轮必带' : '按需 / 已关闭',
                  color: source.always ? scheme.primaryContainer : scheme.surfaceContainerHighest,
                  on: source.always ? scheme.onPrimaryContainer : scheme.onSurfaceVariant,
                ),
                if (source.overLimit)
                  _Badge(
                    text: '超限会被整块丢弃',
                    color: scheme.errorContainer,
                    on: scheme.onErrorContainer,
                  ),
              ],
            ),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: percent,
                minHeight: 4,
                backgroundColor: scheme.surfaceContainerHighest,
                color: source.overLimit ? scheme.error : null,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              [
                '${_formatTokens(source.tokens)} token',
                if (source.max != null) '/ 上限 ${_formatTokens(source.max!)}',
                '${_formatTokens(source.bytes)} 字节',
                if (source.entries != null) '${source.entries} 条',
              ].join(' · '),
              style: TextStyle(fontSize: 11, color: scheme.outline),
            ),
            const SizedBox(height: 6),
            Text(source.role, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant, height: 1.45)),
            const SizedBox(height: 8),
            if (source.editable)
              _Editor(
                initial: draft ?? source.editText,
                onChanged: onChanged,
                hint: source.entries != null && source.entries! > 0
                    // 手改记忆层会重建条目元数据，必须提前说，否则「用过几次」会莫名归零。
                    ? '注意：手动改这一层会重置它的条目统计（使用次数、置顶、最近使用）。'
                    : null,
              )
            else
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    source.readonlyReason ?? '此处不可编辑',
                    style: TextStyle(fontSize: 12, color: scheme.outline, height: 1.4),
                  ),
                  const SizedBox(height: 6),
                  _Preview(text: source.content),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// 可编辑正文。默认折叠成 7 行，展开后不限高。
class _Editor extends StatefulWidget {
  const _Editor({required this.initial, required this.onChanged, this.hint});

  final String initial;
  final ValueChanged<String> onChanged;
  final String? hint;

  @override
  State<_Editor> createState() => _EditorState();
}

class _EditorState extends State<_Editor> {
  late final TextEditingController _controller = TextEditingController(text: widget.initial);
  var _expanded = false;

  @override
  void didUpdateWidget(covariant _Editor oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 「放弃改动」会换掉整棵卡片的 key，正常不会走到这里；
    // 但「重新读取」只刷新数据、不换 key，此时编辑框必须跟上磁盘内容，
    // 否则页面上显示的是旧文本，用户以为没读到。
    if (oldWidget.initial != widget.initial && _controller.text != widget.initial) {
      _controller.text = widget.initial;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.hint != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              widget.hint!,
              style: TextStyle(fontSize: 11, color: scheme.error, height: 1.4),
            ),
          ),
        TextField(
          controller: _controller,
          onChanged: widget.onChanged,
          minLines: _expanded ? 18 : 7,
          maxLines: _expanded ? null : 7,
          keyboardType: TextInputType.multiline,
          style: const TextStyle(fontSize: 12, height: 1.5, fontFamily: 'monospace'),
          decoration: InputDecoration(
            isDense: true,
            filled: true,
            fillColor: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: () => setState(() => _expanded = !_expanded),
            child: Text(_expanded ? '收起' : '展开编辑'),
          ),
        ),
      ],
    );
  }
}

/// 只读预览：前 1200 字符，与应用无关的长块不必整段渲染。
class _Preview extends StatelessWidget {
  const _Preview({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final shown = text.length > 1200 ? '${text.substring(0, 1200)}\n…' : text;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Text(
        shown.isEmpty ? '（空）' : shown,
        style: const TextStyle(fontSize: 12, height: 1.5, fontFamily: 'monospace'),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.color, required this.on});

  final String text;
  final Color color;
  final Color on;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(4)),
      child: Text(text, style: TextStyle(fontSize: 10, color: on)),
    );
  }
}

String _formatTokens(int value) {
  final text = value.toString();
  final buffer = StringBuffer();
  for (var i = 0; i < text.length; i += 1) {
    if (i > 0 && (text.length - i) % 3 == 0) buffer.write(',');
    buffer.write(text[i]);
  }
  return buffer.toString();
}
