import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'chat_page.dart';

class SessionListPage extends StatefulWidget {
  const SessionListPage({
    super.key,
    required this.controller,
    this.pushChat = true,
    this.restoreLast = true,
  });
  final AppController controller;
  final bool pushChat;
  final bool restoreLast;

  @override
  State<SessionListPage> createState() => _SessionListPageState();
}

class _SessionListPageState extends State<SessionListPage> {
  String? _error;
  bool _restored = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      await widget.controller.refreshSessions();
      if (!mounted || _restored || !widget.restoreLast) return;
      _restored = true;
      final lastId = await widget.controller.lastActiveSessionId();
      if (!mounted || lastId == null) return;
      final exists = widget.controller.sessions.any((session) => session.id == lastId);
      if (exists) _open(lastId);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _error = error.message);
    } on Object catch (error) {
      if (mounted) setState(() => _error = '$error');
    }
  }

  void _open(String sessionId) {
    widget.controller.openSession(sessionId);
    if (!widget.pushChat) {
      Navigator.of(context).maybePop();
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ChatPage(controller: widget.controller, sessionId: sessionId),
    ));
  }

  Future<void> _create() async {
    try {
      final created = await widget.controller.createSession();
      if (!mounted || created.id.isEmpty) return;
      _open(created.id);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _rename(SessionSummary session) async {
    final title = TextEditingController(text: session.title);
    final next = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('重命名'),
        content: TextField(controller: title, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, title.text.trim()), child: const Text('保存')),
        ],
      ),
    );
    title.dispose();
    if (next == null || next.isEmpty || !mounted) return;
    try {
      await widget.controller.renameSession(session.id, next);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _delete(SessionSummary session) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('删除「${session.title.isEmpty ? '未命名' : session.title}」？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('删除')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await widget.controller.deleteSession(session.id);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('会话'),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _create,
        child: const Icon(Icons.add),
      ),
      body: RefreshIndicator(
        onRefresh: widget.controller.refreshSessions,
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            if (_error != null) return Center(child: Text(_error!));
            final sessions = widget.controller.sessions;
            if (sessions.isEmpty) {
              return ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: const [SizedBox(height: 120), Center(child: Text('还没有会话'))],
              );
            }
            return ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: sessions.length,
              itemBuilder: (context, index) {
                final session = sessions[index];
                return ListTile(
                  title: Text(session.title.isEmpty ? '未命名' : session.title),
                  subtitle: Text(session.updatedAt),
                  onTap: () => _open(session.id),
                  trailing: PopupMenuButton<String>(
                    onSelected: (value) async {
                      if (value == 'rename') await _rename(session);
                      if (value == 'delete') await _delete(session);
                    },
                    itemBuilder: (context) => const [
                      PopupMenuItem(value: 'rename', child: Text('重命名')),
                      PopupMenuItem(value: 'delete', child: Text('删除')),
                    ],
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }
}
