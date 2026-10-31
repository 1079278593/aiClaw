import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import '../src/reflection_groups.dart';
import 'reflection_list_rows.dart';
import 'reflection_page.dart';

class _Node {
  _Node.fromJson(Map<String, Object?> json)
    : name = '${json['name'] ?? ''}',
      path = '${json['path'] ?? ''}',
      kind = '${json['kind'] ?? ''}',
      title = '${json['title'] ?? ''}',
      excerpt = '${json['excerpt'] ?? ''}',
      occurredAt = '${json['occurredAt'] ?? ''}',
      updatedAt = '${json['updatedAt'] ?? ''}',
      noteCount = json['noteCount'] is num ? (json['noteCount'] as num).toInt() : 0,
      children = [
        for (final item
            in json['children'] is List ? json['children'] as List : const [])
          if (item is Map) _Node.fromJson(Map<String, Object?>.from(item)),
      ];

  final String name;
  final String path;
  final String kind;
  final String title;
  final String excerpt;
  final String occurredAt;
  final String updatedAt;
  final int noteCount;
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

  /// 徽标数字：本篇与所有子文件夹的笔记总数。
  int get totalNotes {
    if (noteCount > 0) return noteCount;
    var total = 0;
    for (final node in children) {
      total += node.kind == 'file' ? 1 : node.totalNotes;
    }
    return total;
  }
}

String _folderKey(String path) {
  const root = 'inputs/reflections';
  if (path == root || path.isEmpty) return '';
  if (path.startsWith('$root/')) return path.substring(root.length + 1);
  return path;
}

class _NodeAction {
  const _NodeAction(this.id, this.label, this.icon, {this.danger = false});

  final String id;
  final String label;
  final IconData icon;
  final bool danger;
}

Future<String?> _pickNodeAction(BuildContext context, List<_NodeAction> actions) {
  return showModalBottomSheet<String>(
    context: context,
    builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final action in actions)
              ListTile(
                leading: Icon(action.icon, color: action.danger ? scheme.error : null),
                title: Text(
                  action.label,
                  style: action.danger ? TextStyle(color: scheme.error) : null,
                ),
                onTap: () => Navigator.pop(context, action.id),
              ),
          ],
        ),
      );
    },
  );
}

Future<String?> _promptName(
  BuildContext context,
  String title, {
  String label = '名称',
  String initial = '',
}) {
  return showDialog<String>(
    context: context,
    builder: (context) => _NameDialog(title: title, label: label, initial: initial),
  );
}

Future<bool> _confirmAction(BuildContext context, String title, String message) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('取消'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: Text(
            '删除',
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ),
      ],
    ),
  );
  return result == true;
}

void _showError(BuildContext context, ApiException error) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(error.message)));
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

  Future<void> _folderMenu(_Node folder) async {
    final action = await _pickNodeAction(context, const [
      _NodeAction('rename', '重命名文件夹', Icons.drive_file_rename_outline),
      _NodeAction('delete', '删除文件夹', Icons.delete_outline, danger: true),
    ]);
    if (action == null || !mounted) return;
    if (action == 'rename') {
      final name = await _promptName(context, '重命名文件夹', initial: folder.name);
      if (name == null || name.isEmpty || !mounted) return;
      try {
        await widget.controller.api.sendJson(
          'POST',
          apiUri(widget.controller.baseUrl, '/api/reflections/rename-folder'),
          token: widget.controller.token,
          body: {'path': folder.path, 'name': name},
        );
        await _load();
      } on ApiException catch (error) {
        if (mounted) _showError(context, error);
      }
      return;
    }
    if (action == 'delete') {
      final ok = await _confirmAction(
        context,
        '删除文件夹',
        '「${folder.name}」里的心得和附件会一起删掉。',
      );
      if (!ok || !mounted) return;
      try {
        await widget.controller.api.sendJson(
          'DELETE',
          apiUri(widget.controller.baseUrl, '/api/reflections/folder', {'path': folder.path}),
          token: widget.controller.token,
        );
        _expanded.removeWhere((path) => path == folder.path || path.startsWith('${folder.path}/'));
        await _load();
      } on ApiException catch (error) {
        if (mounted) _showError(context, error);
      }
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
        ReflectionFolderRow(
          name: folder.name,
          noteCount: folder.totalNotes,
          depth: depth,
          expandable: nested.isNotEmpty,
          expanded: open,
          onToggleExpand: () => setState(() {
            if (open) {
              _expanded.remove(folder.path);
            } else {
              _expanded.add(folder.path);
            }
          }),
          onTap: () => _openFolder(folder),
          onLongPress: () => _folderMenu(folder),
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

  Future<List<_Node>> _loadRoots() async {
    final payload = await widget.controller.api.getJson(
      apiUri(widget.controller.baseUrl, '/api/reflections', {'view': 'tree'}),
      token: widget.controller.token,
    );
    final raw = payload['tree'];
    return [
      for (final item in raw is List ? raw : const [])
        if (item is Map) _Node.fromJson(Map<String, Object?>.from(item)),
    ];
  }

  String _noteTitle(_Node note) => note.title.isEmpty ? note.name : note.title;

  /// 一行摘要：时间在前，正文在后面，跟苹果备忘录一致。
  String _notePreview(_Node note) {
    final when = reflectionRowTimeLabel(
      note.updatedAt.isEmpty ? note.occurredAt : note.updatedAt,
      DateTime.now(),
    );
    final excerpt = note.excerpt.replaceAll(RegExp(r'\s+'), ' ').trim();
    final line = [when, excerpt].where((part) => part.isNotEmpty).join('  ');
    return line.isEmpty ? '无正文' : line;
  }

  Future<void> _noteMenu(_Node note) async {
    final action = await _pickNodeAction(context, const [
      _NodeAction('rename', '重命名', Icons.drive_file_rename_outline),
      _NodeAction('move', '移动到…', Icons.drive_file_move_outline),
      _NodeAction('delete', '删除', Icons.delete_outline, danger: true),
    ]);
    if (action == null || !mounted) return;
    if (action == 'rename') await _renameNote(note);
    if (action == 'move') await _moveNote(note);
    if (action == 'delete') await _deleteNote(note);
  }

  Future<void> _renameNote(_Node note) async {
    final next = await _promptName(
      context,
      '重命名心得',
      label: '标题',
      initial: _noteTitle(note),
    );
    if (next == null || next.isEmpty || !mounted) return;
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/reflections/content', {'path': note.path}),
        token: widget.controller.token,
      );
      final doc = payload['reflection'];
      final body = doc is Map ? '${doc['body'] ?? ''}' : '';
      await widget.controller.api.sendJson(
        'PUT',
        apiUri(widget.controller.baseUrl, '/api/reflections/content'),
        token: widget.controller.token,
        body: {'path': note.path, 'title': next, 'body': body},
      );
      await _reload();
    } on ApiException catch (error) {
      if (mounted) _showError(context, error);
    }
  }

  Future<void> _moveNote(_Node note) async {
    List<_Node> roots;
    try {
      roots = await _loadRoots();
    } on ApiException catch (error) {
      if (mounted) _showError(context, error);
      return;
    }
    final folders = <String>[];
    void walk(List<_Node> nodes) {
      for (final node in nodes) {
        if (node.kind != 'directory') continue;
        folders.add(node.path);
        walk(node.children);
      }
    }
    walk(roots);
    if (!mounted) return;
    if (folders.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('还没有别的文件夹')));
      return;
    }
    final target = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const ListTile(dense: true, title: Text('移动到')),
            for (final folder in folders)
              ListTile(
                leading: const Icon(Icons.folder_outlined),
                title: Text(_folderKey(folder).isEmpty ? '/' : _folderKey(folder)),
                onTap: () => Navigator.pop(context, folder),
              ),
          ],
        ),
      ),
    );
    if (target == null || !mounted) return;
    try {
      await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/reflections/move'),
        token: widget.controller.token,
        body: {'from': note.path, 'toFolder': target},
      );
      await _reload();
    } on ApiException catch (error) {
      if (mounted) _showError(context, error);
    }
  }

  Future<void> _deleteNote(_Node note) async {
    final ok = await _confirmAction(
      context,
      '删除心得',
      '「${_noteTitle(note)}」和它的附件会一起删掉。',
    );
    if (!ok || !mounted) return;
    try {
      await widget.controller.api.sendJson(
        'DELETE',
        apiUri(widget.controller.baseUrl, '/api/reflections', {'path': note.path}),
        token: widget.controller.token,
      );
      await _reload();
    } on ApiException catch (error) {
      if (mounted) _showError(context, error);
    }
  }

  Future<void> _childFolderMenu(_Node folder) async {
    final action = await _pickNodeAction(context, const [
      _NodeAction('rename', '重命名文件夹', Icons.drive_file_rename_outline),
      _NodeAction('delete', '删除文件夹', Icons.delete_outline, danger: true),
    ]);
    if (action == null || !mounted) return;
    if (action == 'rename') {
      final name = await _promptName(context, '重命名文件夹', initial: folder.name);
      if (name == null || name.isEmpty || !mounted) return;
      try {
        await widget.controller.api.sendJson(
          'POST',
          apiUri(widget.controller.baseUrl, '/api/reflections/rename-folder'),
          token: widget.controller.token,
          body: {'path': folder.path, 'name': name},
        );
        await _reload();
      } on ApiException catch (error) {
        if (mounted) _showError(context, error);
      }
      return;
    }
    if (action == 'delete') {
      final ok = await _confirmAction(
        context,
        '删除文件夹',
        '「${folder.name}」里的心得和附件会一起删掉。',
      );
      if (!ok || !mounted) return;
      try {
        await widget.controller.api.sendJson(
          'DELETE',
          apiUri(widget.controller.baseUrl, '/api/reflections/folder', {'path': folder.path}),
          token: widget.controller.token,
        );
        await _reload();
      } on ApiException catch (error) {
        if (mounted) _showError(context, error);
      }
    }
  }

  Future<void> _currentFolderMenu() async {
    final action = await _pickNodeAction(context, const [
      _NodeAction('rename', '重命名文件夹', Icons.drive_file_rename_outline),
      _NodeAction('delete', '删除文件夹', Icons.delete_outline, danger: true),
    ]);
    if (action == null || !mounted) return;
    if (action == 'rename') {
      final name = await _promptName(context, '重命名文件夹', initial: _folder.name);
      if (name == null || name.isEmpty || !mounted) return;
      try {
        await widget.controller.api.sendJson(
          'POST',
          apiUri(widget.controller.baseUrl, '/api/reflections/rename-folder'),
          token: widget.controller.token,
          body: {'path': _folder.path, 'name': name},
        );
        await widget.reloadTree();
        if (mounted) Navigator.of(context).pop();
      } on ApiException catch (error) {
        if (mounted) _showError(context, error);
      }
      return;
    }
    if (action == 'delete') {
      final ok = await _confirmAction(
        context,
        '删除文件夹',
        '「${_folder.name}」里的心得和附件会一起删掉。',
      );
      if (!ok || !mounted) return;
      try {
        await widget.controller.api.sendJson(
          'DELETE',
          apiUri(widget.controller.baseUrl, '/api/reflections/folder', {'path': _folder.path}),
          token: widget.controller.token,
        );
        await widget.reloadTree();
        if (mounted) Navigator.of(context).pop();
      } on ApiException catch (error) {
        if (mounted) _showError(context, error);
      }
    }
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
            onPressed: _currentFolderMenu,
            tooltip: '文件夹操作',
            icon: const Icon(Icons.more_horiz),
          ),
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
                  ReflectionFolderRow(
                    name: folder.name,
                    noteCount: folder.totalNotes,
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
                    onLongPress: () => _childFolderMenu(folder),
                  ),
                for (final label in labels) ...[
                  ListTile(dense: true, title: Text(label)),
                  for (final note in groups[label]!)
                    ReflectionNoteRow(
                      title: _noteTitle(note),
                      preview: _notePreview(note),
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
                      onLongPress: () => _noteMenu(note),
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
  const _NameDialog({required this.title, required this.label, this.initial = ''});

  final String title;
  final String label;
  final String initial;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initial);

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
