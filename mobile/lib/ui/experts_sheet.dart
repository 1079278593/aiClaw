import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';

/// 领域勾选面板（plan_experts §4）。
///
/// 四条交互规则与桌面端一致，不能因为「手机上不那么明显」就省掉：
/// 1. 切换后立刻保存；失败退回上一次成功的名单并提示。
/// 2. 发送前等保存完成（由 [AppController.setSessionExperts] 的 Future 保证）。
/// 3. 生成中的那一轮不改勾选，从下一条消息起生效。
/// 4. 已勾 2 个再点第三个：拒绝，不自动换掉其中一个。
Future<void> showExpertsSheet(
  BuildContext context, {
  required AppController controller,
  required String sessionId,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _ExpertsSheet(controller: controller, sessionId: sessionId),
  );
}

class _ExpertsSheet extends StatefulWidget {
  const _ExpertsSheet({required this.controller, required this.sessionId});

  final AppController controller;
  final String sessionId;

  @override
  State<_ExpertsSheet> createState() => _ExpertsSheetState();
}

class _ExpertsSheetState extends State<_ExpertsSheet> {
  final _createInput = TextEditingController();
  List<String> _available = const [];
  List<String> _picked = const [];
  bool _loading = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _picked = List<String>.from(widget.controller.machine.runtimeOf(widget.sessionId).experts ?? const []);
    _load();
  }

  @override
  void dispose() {
    _createInput.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final available = await widget.controller.loadExperts();
      if (!mounted) return;
      setState(() {
        _available = available;
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = _describe(error);
      });
    }
  }

  String _describe(Object error) {
    if (error is ApiException) return error.message;
    return error.toString();
  }

  Future<void> _toggle(String id) async {
    if (_busy) return;
    final previous = List<String>.from(_picked);
    final next = previous.contains(id)
        ? (previous.toList()..remove(id))
        : <String>[...previous, id];
    if (next.length > 2) {
      setState(() => _error = '最多勾 2 个。要换请先取消一个。');
      return;
    }
    // 生成中的那一轮系统提示已装好，改勾只从下一条消息起生效。
    if (widget.controller.machine.runtimeOf(widget.sessionId).isStreaming) {
      setState(() => _error = '正在生成，这一轮的领域不变；下一条消息起生效。');
      return;
    }
    setState(() {
      _picked = next;
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.setSessionExperts(widget.sessionId, next);
    } catch (error) {
      // 保存失败：退回上一次成功的名单，界面与磁盘保持一致。
      if (!mounted) return;
      setState(() {
        _picked = previous;
        _error = '${_describe(error)}（已退回上一次的勾选）';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _create() async {
    final id = _createInput.text.trim();
    if (id.isEmpty) {
      setState(() => _error = '先填领域名');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.createExpert(id);
      _createInput.clear();
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = _describe(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          bottom: MediaQuery.of(context).viewInsets.bottom + 16,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('领域', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              '勾上之后这一轮带上该领域的规则和目录，正文仍由 AI 按需打开。最多 2 个。',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_available.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text('还没有领域。在下面输入名称新建一个，或直接在 knowledge_base 下建子目录并写上 rules.md。',
                    style: theme.textTheme.bodySmall),
              )
            else
              ..._available.map((id) {
                final checked = _picked.contains(id);
                return CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: checked,
                  onChanged: _busy ? null : (_) => _toggle(id),
                  title: Text(id),
                );
              }),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _createInput,
                    decoration: const InputDecoration(hintText: '新建领域名，如「情感」', isDense: true),
                    maxLength: 64,
                    onSubmitted: (_) => _busy ? null : _create(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _busy ? null : _create,
                  child: const Text('新建'),
                ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(
                _error!,
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
