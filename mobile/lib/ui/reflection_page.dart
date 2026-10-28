import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'chat_page.dart';

class ReflectionPage extends StatefulWidget {
  const ReflectionPage({
    super.key,
    required this.controller,
    this.path,
    this.folder = 'inbox',
  });

  final AppController controller;
  final String? path;
  final String folder;

  @override
  State<ReflectionPage> createState() => _ReflectionPageState();
}

class _ReflectionPageState extends State<ReflectionPage> {
  final _title = TextEditingController();
  final _body = TextEditingController();
  final _bodyFocus = FocusNode();
  String _path = '';
  String? _error;
  var _loading = false;
  var _saving = false;

  @override
  void initState() {
    super.initState();
    _path = widget.path ?? '';
    if (_path.isNotEmpty) _load();
  }

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    _bodyFocus.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/reflections/content', {
          'path': _path,
        }),
        token: widget.controller.token,
      );
      final reflection = payload['reflection'];
      if (reflection is! Map) throw ApiException(500, '无效响应');
      final map = Map<String, Object?>.from(reflection);
      if (!mounted) return;
      setState(() {
        _path = '${map['path'] ?? _path}';
        _title.text = '${map['title'] ?? ''}';
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
    final title = _title.text.trim();
    if (title.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('标题不能为空')));
      return;
    }
    setState(() => _saving = true);
    try {
      final creating = _path.isEmpty;
      final payload = await widget.controller.api.sendJson(
        creating ? 'POST' : 'PUT',
        apiUri(
          widget.controller.baseUrl,
          creating ? '/api/reflections' : '/api/reflections/content',
        ),
        token: widget.controller.token,
        body: {
          if (!creating) 'path': _path,
          'title': title,
          'body': _body.text,
          if (creating)
            'folder': widget.folder.isEmpty ? 'inbox' : widget.folder,
        },
      );
      final reflection = payload['reflection'];
      if (reflection is Map) {
        _path = '${reflection['path'] ?? _path}';
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('已保存')));
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _ask() async {
    if (_path.isEmpty) return;
    try {
      final opened = await widget.controller.openDocumentAt(_path);
      if (!opened) {
        if (!mounted) return;
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('无法附带该心得')));
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
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ChatPage(controller: widget.controller, sessionId: sessionId!),
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final titleStyle = Theme.of(context).textTheme.headlineSmall;
    final bodyStyle = Theme.of(context).textTheme.bodyMedium;
    return Scaffold(
      appBar: AppBar(
        title: Text(_title.text.trim().isEmpty ? '心得' : _title.text.trim()),
        actions: [
          IconButton(
            onPressed: _saving ? null : _save,
            icon: _saving
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_outlined),
          ),
          IconButton(
            onPressed: _path.isEmpty ? null : _ask,
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
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
              children: [
                TextField(
                  controller: _title,
                  style: titleStyle,
                  decoration: const InputDecoration(
                    hintText: '标题',
                    border: InputBorder.none,
                  ),
                  textInputAction: TextInputAction.next,
                  onSubmitted: (_) => _bodyFocus.requestFocus(),
                  onChanged: (_) => setState(() {}),
                ),
                TextField(
                  controller: _body,
                  focusNode: _bodyFocus,
                  style: bodyStyle,
                  decoration: const InputDecoration(
                    hintText: '正文',
                    border: InputBorder.none,
                  ),
                  keyboardType: TextInputType.multiline,
                  maxLines: null,
                  minLines: 12,
                ),
              ],
            ),
    );
  }
}
