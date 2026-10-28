import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'reflection_page.dart';

class ReflectionSummary {
  ReflectionSummary.fromJson(Map<String, Object?> json)
      : path = '${json['path'] ?? ''}',
        title = '${json['title'] ?? '未命名'}',
        occurredAt = '${json['occurredAt'] ?? ''}',
        context = '${json['context'] ?? ''}',
        folder = '${json['folder'] ?? ''}';

  final String path;
  final String title;
  final String occurredAt;
  final String context;
  final String folder;
}

class ReflectionsListPage extends StatefulWidget {
  const ReflectionsListPage({super.key, required this.controller});

  final AppController controller;

  @override
  State<ReflectionsListPage> createState() => _ReflectionsListPageState();
}

class _ReflectionsListPageState extends State<ReflectionsListPage> {
  var _items = <ReflectionSummary>[];
  String? _error;
  var _loading = true;
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    if (widget.controller.baseUrl.isEmpty) {
      _loading = false;
      _error = '未连接';
      return;
    }
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final q = _search.text.trim();
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/reflections', {
          if (q.isNotEmpty) 'q': q,
        }),
        token: widget.controller.token,
      );
      final raw = payload['reflections'];
      final items = [
        for (final item in raw is List ? raw : const [])
          if (item is Map) ReflectionSummary.fromJson(Map<String, Object?>.from(item)),
      ];
      if (!mounted) return;
      setState(() {
        _items = items;
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

  Future<void> _create() async {
    final title = await showDialog<String>(
      context: context,
      builder: (context) => const _TitleDialog(),
    );
    if (title == null || title.trim().isEmpty || !mounted) return;
    try {
      final payload = await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/reflections'),
        token: widget.controller.token,
        body: {'title': title.trim(), 'body': '', 'folder': 'inbox'},
      );
      final reflection = payload['reflection'];
      if (reflection is! Map) return;
      final summary = ReflectionSummary.fromJson(Map<String, Object?>.from(reflection));
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => ReflectionPage(controller: widget.controller, path: summary.path),
      ));
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('心得'),
        actions: [
          IconButton(onPressed: _create, icon: const Icon(Icons.note_add_outlined)),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: TextField(
              controller: _search,
              decoration: InputDecoration(
                hintText: '搜索标题 / 情境',
                suffixIcon: IconButton(onPressed: _load, icon: const Icon(Icons.search)),
              ),
              onSubmitted: (_) => _load(),
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? Center(child: Text(_error!))
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: ListView(
                          children: [
                            if (_items.isEmpty) const ListTile(title: Text('还没有心得')),
                            for (final item in _items)
                              ListTile(
                                title: Text(item.title),
                                subtitle: Text(
                                  [
                                    _shortTime(item.occurredAt),
                                    if (item.context.isNotEmpty) item.context,
                                    if (item.folder.isNotEmpty) item.folder,
                                  ].where((part) => part.isNotEmpty).join(' · '),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                onTap: () async {
                                  await Navigator.of(context).push(MaterialPageRoute<void>(
                                    builder: (_) => ReflectionPage(
                                      controller: widget.controller,
                                      path: item.path,
                                    ),
                                  ));
                                  await _load();
                                },
                              ),
                          ],
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}

String _shortTime(String value) {
  final matched = RegExp(r'^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})').firstMatch(value);
  if (matched != null) return '${matched.group(1)} ${matched.group(2)}';
  return value;
}

class _TitleDialog extends StatefulWidget {
  const _TitleDialog();

  @override
  State<_TitleDialog> createState() => _TitleDialogState();
}

class _TitleDialogState extends State<_TitleDialog> {
  final _controller = TextEditingController(text: '未命名心得');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新建心得'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: '标题'),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        TextButton(
          onPressed: () => Navigator.pop(context, _controller.text.trim()),
          child: const Text('创建'),
        ),
      ],
    );
  }
}
