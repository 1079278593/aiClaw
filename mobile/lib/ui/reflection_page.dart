import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'chat_page.dart';

class ReflectionPage extends StatefulWidget {
  const ReflectionPage({
    super.key,
    required this.controller,
    required this.path,
  });

  final AppController controller;
  final String path;

  @override
  State<ReflectionPage> createState() => _ReflectionPageState();
}

class _ReflectionPageState extends State<ReflectionPage> {
  final _title = TextEditingController();
  final _occurred = TextEditingController();
  final _context = TextEditingController();
  final _body = TextEditingController();
  String _path = '';
  String? _error;
  var _loading = true;
  var _saving = false;

  @override
  void initState() {
    super.initState();
    _path = widget.path;
    _load();
  }

  @override
  void dispose() {
    _title.dispose();
    _occurred.dispose();
    _context.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/reflections/content', {'path': _path}),
        token: widget.controller.token,
      );
      final reflection = payload['reflection'];
      if (reflection is! Map) throw ApiException(500, '无效响应');
      final map = Map<String, Object?>.from(reflection);
      if (!mounted) return;
      setState(() {
        _path = '${map['path'] ?? _path}';
        _title.text = '${map['title'] ?? ''}';
        _occurred.text = '${map['occurredAt'] ?? ''}';
        _context.text = '${map['context'] ?? ''}';
        _body.text = '${map['body'] ?? ''}';
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      final payload = await widget.controller.api.sendJson(
        'PUT',
        apiUri(widget.controller.baseUrl, '/api/reflections/content'),
        token: widget.controller.token,
        body: {
          'path': _path,
          'title': _title.text.trim(),
          'occurredAt': _occurred.text.trim(),
          'context': _context.text.trim(),
          'body': _body.text,
        },
      );
      final reflection = payload['reflection'];
      if (reflection is Map) {
        _path = '${reflection['path'] ?? _path}';
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已保存')));
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _ask() async {
    try {
      final opened = await widget.controller.openDocumentAt(_path);
      if (!opened) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('无法附带该心得')));
        return;
      }
      await widget.controller.setAttachDocument(true);
      var sessionId = widget.controller.machine.currentSessionId;
      if (sessionId == null || sessionId.isEmpty) {
        final created = await widget.controller.createSession();
        if (created.id.isEmpty) return;
        widget.controller.openSession(created.id);
        sessionId = created.id;
      }
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => ChatPage(controller: widget.controller, sessionId: sessionId!),
      ));
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_title.text.isEmpty ? '心得' : _title.text),
        actions: [
          IconButton(
            onPressed: _saving ? null : _save,
            icon: _saving
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.save_outlined),
          ),
          IconButton(
            onPressed: _ask,
            tooltip: '拿去问',
            icon: const Icon(Icons.chat_bubble_outline),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    TextField(
                      controller: _title,
                      decoration: const InputDecoration(labelText: '标题'),
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _occurred,
                      decoration: const InputDecoration(labelText: '发生时刻'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _context,
                      decoration: const InputDecoration(labelText: '情境'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _body,
                      decoration: const InputDecoration(labelText: '正文', alignLabelWithHint: true),
                      minLines: 12,
                      maxLines: null,
                    ),
                    const SizedBox(height: 12),
                    Text(_path, style: Theme.of(context).textTheme.bodySmall),
                  ],
                ),
    );
  }
}
