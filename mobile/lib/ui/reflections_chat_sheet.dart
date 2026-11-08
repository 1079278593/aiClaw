import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'chat_page.dart';

/// 心得首页底部的「对话 / 待应用」入口与 90% 弹层
/// （mobile/docs/… plan_reflections_chat.md §10.2）。
const reflectionsEntryBottomInset = 12.0;

/// 列表底部要给按钮让出的高度：按钮高度 + 上下间距。
const reflectionsEntryReserve = 76.0;

/// 打开心得对话层。高度约屏幕 90%，上限 720。
Future<void> showReflectionsChatSheet(BuildContext context, AppController controller) async {
  final media = MediaQuery.of(context);
  final maxHeight = media.size.height * 0.9;
  final height = maxHeight > 720 ? 720.0 : maxHeight;

  String? sessionId;
  Object? error;
  try {
    sessionId = await controller.openReflectionsSession();
  } on ApiException catch (e) {
    error = e;
  }
  if (!context.mounted) return;
  if (sessionId == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(error is ApiException ? error.message : '无法打开心得对话')),
    );
    return;
  }
  // 弹层借用当前会话位：关掉后要退回原会话，否则切到「聊天」会看到心得对话。
  final previousSessionId = controller.machine.currentSessionId;
  controller.openSession(sessionId);
  try {
    await _showChatSheet(context, controller, sessionId, height);
  } finally {
    if (previousSessionId != null && previousSessionId != sessionId) {
      controller.openSession(previousSessionId);
    }
  }
}

Future<void> _showChatSheet(
  BuildContext context,
  AppController controller,
  String sessionId,
  double height,
) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return SizedBox(
        height: height,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
              child: Row(
                children: [
                  const Expanded(
                    child: Text('心得对话', style: TextStyle(fontWeight: FontWeight.w600)),
                  ),
                  IconButton(
                    tooltip: '待应用',
                    onPressed: () => showPendingSheet(context, controller),
                    icon: const Icon(Icons.inbox_outlined),
                  ),
                  IconButton(
                    tooltip: '收起',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.keyboard_arrow_down),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: scheme.outlineVariant),
            Expanded(
              child: ChatPage(
                key: ValueKey(sessionId),
                controller: controller,
                sessionId: sessionId,
                embedded: true,
                title: '心得对话',
                onOrganizeSent: () => Navigator.of(context).pop(),
              ),
            ),
          ],
        ),
      );
    },
  );
}

/// 「待应用」列表：一条 pending 展开成 base / proposed 对比 + 应用 / 丢弃。
Future<void> showPendingSheet(BuildContext context, AppController controller) async {
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => FractionallySizedBox(
      heightFactor: 0.9,
      child: _PendingList(controller: controller),
    ),
  );
}

class _PendingItem {
  _PendingItem.fromJson(Map<String, Object?> json)
    : id = '${json['id'] ?? ''}',
      target = '${json['target'] ?? ''}',
      summary = '${json['summary'] ?? ''}',
      changeType = '${json['changeType'] ?? ''}';

  final String id;
  final String target;
  final String summary;
  final String changeType;

  String get changeLabel => changeType == 'create' ? '新建' : '修改';
}

class _PendingList extends StatefulWidget {
  const _PendingList({required this.controller});

  final AppController controller;

  @override
  State<_PendingList> createState() => _PendingListState();
}

class _PendingListState extends State<_PendingList> {
  var _loading = true;
  String? _error;
  List<_PendingItem> _items = [];
  String? _openId;
  Map<String, Object?>? _detail;
  var _busy = false;

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
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/pending'),
        token: widget.controller.token,
      );
      final raw = payload['items'];
      if (!mounted) return;
      setState(() {
        _items = [
          for (final item in raw is List ? raw : const [])
            if (item is Map) _PendingItem.fromJson(Map<String, Object?>.from(item)),
        ];
        _loading = false;
        if (_openId != null && !_items.any((item) => item.id == _openId)) {
          _openId = null;
          _detail = null;
        }
      });
      await widget.controller.refreshPendingBadge();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  Future<void> _open(_PendingItem item) async {
    setState(() {
      _openId = item.id;
      _detail = null;
    });
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/pending/${item.id}'),
        token: widget.controller.token,
      );
      if (!mounted || _openId != item.id) return;
      setState(() => _detail = payload);
    } on ApiException catch (error) {
      if (mounted) _snack(error.message);
    }
  }

  Future<void> _apply(_PendingItem item) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final payload = await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/pending/${item.id}/apply'),
        token: widget.controller.token,
        body: const {},
      );
      final status = '${payload['status'] ?? ''}';
      if (payload['ok'] == false && status == 'stale') {
        _snack('原文已被改动或移动，提案已失效。');
      } else if (payload['indexSynced'] == false) {
        _snack('已应用，但索引暂未更新，下次会自动修复。');
      }
      await _load();
    } on ApiException catch (error) {
      _snack(error.statusCode == 409 ? '原文在这期间被改动过，提案已失效。' : error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 全部应用（对齐桌面端 `apply-all`）：不是原子操作，逐条表达结果。
  /// 冲突条目保留在列表里，让用户逐条看清「哪一条没成、为什么」。
  Future<void> _applyAll() async {
    if (_busy || _items.isEmpty) return;
    setState(() => _busy = true);
    try {
      final payload = await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/pending/apply-all'),
        token: widget.controller.token,
        body: const {},
      );
      final applied = payload['applied'] is num ? (payload['applied'] as num).toInt() : 0;
      final stale = payload['stale'] is num ? (payload['stale'] as num).toInt() : 0;
      final conflict = payload['conflict'] is num ? (payload['conflict'] as num).toInt() : 0;
      final failed = payload['failed'] is num ? (payload['failed'] as num).toInt() : 0;

      // 具体情况逐条说清，不要汇总成一个「成功」。
      final parts = <String>[];
      if (applied > 0) parts.add('已应用 $applied 条');
      if (stale > 0) parts.add('$stale 条已失效（原文改动或移动）');
      if (conflict > 0) parts.add('$conflict 条冲突');
      if (failed > 0) parts.add('$failed 条失败');
      _snack(parts.isEmpty ? '没有可应用的改动。' : parts.join('，'));

      if (applied > 0) {
        setState(() {
          _openId = null;
          _detail = null;
        });
      }
      await _load();
    } on ApiException catch (error) {
      _snack(error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _dismiss(_PendingItem item) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/pending/${item.id}/dismiss'),
        token: widget.controller.token,
        body: const {},
      );
      await _load();
    } on ApiException catch (error) {
      _snack(error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _confirmApplyAll() async {
    final count = _items.length;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('全部应用 $count 条改动？'),
        content: const Text('会依次应用全部提案。原文在此期间改动过的条目会失败并保持原样，不会被覆盖。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('全部应用'),
          ),
        ],
      ),
    );
    if (ok == true) await _applyAll();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
          child: Row(
            children: [
              const Expanded(
                child: Text('待应用的改动', style: TextStyle(fontWeight: FontWeight.w600)),
              ),
              TextButton(
                // 批量应用不可撤销，这里显式二次确认；桌面端直接执行，移动端更易误触。
                onPressed: _busy || _items.isEmpty ? null : _confirmApplyAll,
                child: Text(_items.isEmpty ? '全部应用' : '全部应用（${_items.length}）'),
              ),
              IconButton(
                tooltip: '关闭',
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close),
              ),
            ],
          ),
        ),
        Divider(height: 1, color: scheme.outlineVariant),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? Center(child: Text(_error!))
                  : _items.isEmpty
                      ? const Center(child: Text('没有待应用的改动'))
                      : ListView(
                          children: [
                            for (final item in _items) ...[
                              ListTile(
                                leading: Icon(
                                  item.changeType == 'create'
                                      ? Icons.note_add_outlined
                                      : Icons.edit_note_outlined,
                                ),
                                title: Text(
                                  item.summary.isEmpty ? item.target : item.summary,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                subtitle: Text(
                                  '${item.changeLabel} · ${item.target}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                selected: _openId == item.id,
                                onTap: () => _open(item),
                              ),
                              if (_openId == item.id)
                                _detail == null
                                    ? const Padding(
                                        padding: EdgeInsets.all(16),
                                        child: Center(child: CircularProgressIndicator()),
                                      )
                                    : _detailView(item),
                              Divider(height: 1, color: scheme.outlineVariant),
                            ],
                          ],
                        ),
        ),
      ],
    );
  }

  Widget _detailView(_PendingItem item) {
    final scheme = Theme.of(context).colorScheme;
    final base = '${_detail?['base'] ?? ''}';
    final proposed = '${_detail?['proposed'] ?? ''}';
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _diffBlock('现在', base.isEmpty ? '（新建文件）' : base, scheme),
          const SizedBox(height: 8),
          _diffBlock('应用后', proposed, scheme),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _busy ? null : () => _apply(item),
                  child: const Text('应用'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : () => _dismiss(item),
                  child: const Text('丢弃'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _diffBlock(String label, String text, ColorScheme scheme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: TextStyle(fontSize: 12, color: scheme.outline)),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.all(8),
          constraints: const BoxConstraints(maxHeight: 180),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: scheme.outlineVariant),
          ),
          child: SingleChildScrollView(
            child: Text(text, style: const TextStyle(fontSize: 12, height: 1.5)),
          ),
        ),
      ],
    );
  }
}
