import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import '../src/reflection_groups.dart';
import 'reflection_page.dart';

class _Node {
  _Node.fromJson(Map<String, Object?> json)
    : name = '${json['name'] ?? ''}',
      path = '${json['path'] ?? ''}',
      kind = '${json['kind'] ?? ''}',
      title = '${json['title'] ?? ''}',
      updatedAt = '${json['updatedAt'] ?? ''}',
      children = [
        for (final item
            in json['children'] is List ? json['children'] as List : const [])
          if (item is Map) _Node.fromJson(Map<String, Object?>.from(item)),
      ];

  final String name;
  final String path;
  final String kind;
  final String title;
  final String updatedAt;
  final List<_Node> children;

  List<_Node> get folders {
    final items = children.where((node) => node.kind == 'directory').toList();
    items.sort((a, b) => a.name.compareTo(b.name));
    return items;
  }

  List<_Node> get notes {
    final items = children.where((node) => node.kind == 'file').toList();
    items.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return items;
  }
}

String _folderKey(String path) {
  const root = 'inputs/reflections';
  if (path == root || path.isEmpty) return '';
  if (path.startsWith('$root/')) return path.substring(root.length + 1);
  return path;
}

class ReflectionsListPage extends StatefulWidget {
  const ReflectionsListPage({super.key, required this.controller});

  final AppController controller;

  @override
  State<ReflectionsListPage> createState() => _ReflectionsListPageState();
}

class _ReflectionsListPageState extends State<ReflectionsListPage> {
  List<_Node> _roots = [];
  final _expanded = <String>{};
  String? _error;
  var _loading = true;

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

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/reflections', {'view': 'tree'}),
        token: widget.controller.token,
      );
      final raw = payload['tree'];
      if (!mounted) return;
      setState(() {
        _roots = [
          for (final item in raw is List ? raw : const [])
            if (item is Map && item['kind'] == 'directory')
              _Node.fromJson(Map<String, Object?>.from(item)),
        ];
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

  Future<void> _newFolder() async {
    final name = await showDialog<String>(
      context: context,
      builder: (context) => const _NameDialog(title: '新建文件夹', label: '名称'),
    );
    if (name == null || name.trim().isEmpty || !mounted) return;
    try {
      await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/reflections/mkdir'),
        token: widget.controller.token,
        body: {'folder': name.trim()},
      );
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _openFolder(_Node folder) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _NotesPage(
          controller: widget.controller,
          folder: folder,
          reloadTree: _load,
        ),
      ),
    );
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('心得'),
        actions: [
          IconButton(
            onPressed: _newFolder,
            tooltip: '新建文件夹',
            icon: const Icon(Icons.create_new_folder_outlined),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? Center(child: Text(_error!))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                children: [
                  if (_roots.isEmpty) const ListTile(title: Text('还没有文件夹')),
                  for (final folder in _roots) _folderTile(folder, 0),
                ],
              ),
            ),
    );
  }

  Widget _folderTile(_Node folder, int depth) {
    final nested = folder.folders;
    final open = _expanded.contains(folder.path);
    return Column(
      children: [
        ListTile(
          contentPadding: EdgeInsets.only(left: 16 + depth * 16, right: 8),
          leading: const Icon(Icons.folder_outlined),
          title: Text(folder.name),
          onTap: () => _openFolder(folder),
          trailing: nested.isEmpty
              ? null
              : IconButton(
                  onPressed: () => setState(() {
                    if (open) {
                      _expanded.remove(folder.path);
                    } else {
                      _expanded.add(folder.path);
                    }
                  }),
                  icon: Icon(open ? Icons.expand_less : Icons.expand_more),
                ),
        ),
        if (open)
          for (final child in nested) _folderTile(child, depth + 1),
      ],
    );
  }
}

class _NotesPage extends StatefulWidget {
  const _NotesPage({
    required this.controller,
    required this.folder,
    required this.reloadTree,
  });

  final AppController controller;
  final _Node folder;
  final Future<void> Function() reloadTree;

  @override
  State<_NotesPage> createState() => _NotesPageState();
}

class _NotesPageState extends State<_NotesPage> {
  late _Node _folder = widget.folder;
  final _draft = TextEditingController();
  var _busy = false;

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    await widget.reloadTree();
    if (!mounted) return;
    final payload = await widget.controller.api.getJson(
      apiUri(widget.controller.baseUrl, '/api/reflections', {'view': 'tree'}),
      token: widget.controller.token,
    );
    final raw = payload['tree'];
    final roots = [
      for (final item in raw is List ? raw : const [])
        if (item is Map) _Node.fromJson(Map<String, Object?>.from(item)),
    ];
    final found = _find(roots, widget.folder.path);
    if (found != null && mounted) setState(() => _folder = found);
  }

  _Node? _find(List<_Node> nodes, String path) {
    for (final node in nodes) {
      if (node.path == path) return node;
      final nested = _find(node.children, path);
      if (nested != null) return nested;
    }
    return null;
  }

  Future<void> _publish() async {
    if (_busy || _draft.text.trim().isEmpty) return;
    final title = await showDialog<String>(
      context: context,
      builder: (context) => const _NameDialog(title: '标题', label: '标题'),
    );
    if (title == null || title.trim().isEmpty || !mounted) return;
    setState(() => _busy = true);
    try {
      await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/reflections'),
        token: widget.controller.token,
        body: {
          'title': title.trim(),
          'body': _draft.text,
          'folder': _folderKey(_folder.path),
        },
      );
      _draft.clear();
      await _reload();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _create() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReflectionPage(
          controller: widget.controller,
          folder: _folderKey(_folder.path),
        ),
      ),
    );
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<_Node>>{};
    final now = DateTime.now();
    for (final note in _folder.notes) {
      final label = reflectionGroupLabel(note.updatedAt, now);
      groups.putIfAbsent(label, () => []).add(note);
    }
    final labels = groups.keys.toList()
      ..sort(
        (a, b) => reflectionGroupRank(a).compareTo(reflectionGroupRank(b)),
      );
    return Scaffold(
      appBar: AppBar(
        title: Text(_folder.name),
        actions: [
          IconButton(
            onPressed: _create,
            tooltip: '创建',
            icon: const Icon(Icons.note_add_outlined),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              children: [
                if (_folder.folders.isNotEmpty)
                  const ListTile(dense: true, title: Text('文件夹')),
                for (final folder in _folder.folders)
                  ListTile(
                    leading: const Icon(Icons.folder_outlined),
                    title: Text(folder.name),
                    onTap: () async {
                      await Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => _NotesPage(
                            controller: widget.controller,
                            folder: folder,
                            reloadTree: widget.reloadTree,
                          ),
                        ),
                      );
                      await _reload();
                    },
                  ),
                for (final label in labels) ...[
                  ListTile(dense: true, title: Text(label)),
                  for (final note in groups[label]!)
                    ListTile(
                      title: Text(note.title.isEmpty ? note.name : note.title),
                      onTap: () async {
                        await Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ReflectionPage(
                              controller: widget.controller,
                              path: note.path,
                              folder: _folderKey(_folder.path),
                            ),
                          ),
                        );
                        await _reload();
                      },
                    ),
                ],
              ],
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 4, 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _draft,
                      minLines: 1,
                      maxLines: 5,
                      keyboardType: TextInputType.multiline,
                      textInputAction: TextInputAction.newline,
                      decoration: const InputDecoration(hintText: '写下来'),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                  IconButton(
                    onPressed: _busy || _draft.text.trim().isEmpty
                        ? null
                        : _publish,
                    icon: const Icon(Icons.send),
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

class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.title, required this.label});

  final String title;
  final String label;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: InputDecoration(labelText: widget.label),
        inputFormatters: [FilteringTextInputFormatter.deny(RegExp(r'[/\\]'))],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _controller.text.trim()),
          child: const Text('确定'),
        ),
      ],
    );
  }
}
