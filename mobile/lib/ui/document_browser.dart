import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'document_reader.dart';

class DocumentBrowser extends StatefulWidget {
  const DocumentBrowser({super.key, required this.controller, required this.onOpen});

  final AppController controller;
  final Future<void> Function(String path) onOpen;

  @override
  State<DocumentBrowser> createState() => _DocumentBrowserState();
}

class _DocumentBrowserState extends State<DocumentBrowser> {
  var _segment = 0;
  String? _path;
  String? _error;
  var _loading = false;
  List<KnowledgeBase> _bases = [];
  List<TreeEntry> _entries = [];

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
      if (_segment == 0 && _path == null) {
        _bases = await widget.controller.loadKnowledge();
      } else {
        _entries = await widget.controller.loadTree(_path ?? _rootPath());
      }
    } on ApiException catch (error) {
      if (!error.unauthorized) _error = error.message;
    } catch (error) {
      _error = '$error';
    }
    if (mounted) setState(() => _loading = false);
  }

  String _rootPath() {
    final trilium = widget.controller.config?.triliumEnabled == true;
    if (_segment == 0) return 'knowledge_base';
    return trilium ? 'knowledge_base' : 'knowledge_base';
  }

  List<String> get _roots {
    final roots = ['knowledge_base', 'inputs'];
    if (widget.controller.config?.triliumEnabled == true) roots.add('trilium');
    return roots;
  }

  Future<void> _open(String path, {required bool directory}) async {
    if (directory) {
      setState(() => _path = path);
      await _load();
      return;
    }
    await widget.onOpen(path);
  }

  @override
  Widget build(BuildContext context) {
    final atRoot = _path == null;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
          child: SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('知识库')),
              ButtonSegment(value: 1, label: Text('目录')),
            ],
            selected: {_segment},
            onSelectionChanged: (value) {
              setState(() {
                _segment = value.first;
                _path = null;
              });
              _load();
            },
          ),
        ),
        if (!atRoot)
          ListTile(
            leading: const Icon(Icons.arrow_back),
            title: Text(_path!),
            onTap: () {
              final slash = _path!.lastIndexOf('/');
              setState(() => _path = slash <= 0 ? null : _path!.substring(0, slash));
              _load();
            },
          ),
        Expanded(child: _body(atRoot)),
      ],
    );
  }

  Widget _body(bool atRoot) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));
    if (_segment == 0 && atRoot) {
      if (_bases.isEmpty) return const Center(child: Text('还没有知识库'));
      return ListView(
        children: [
          for (final base in _bases)
            ListTile(
              leading: const Icon(Icons.menu_book_outlined),
              title: Text(base.name),
              subtitle: Text(base.description),
              onTap: () => _open('knowledge_base/${base.name}', directory: true),
            ),
        ],
      );
    }
    if (_segment == 1 && atRoot) {
      return ListView(
        children: [
          for (final root in _roots)
            ListTile(
              leading: const Icon(Icons.folder_outlined),
              title: Text(root),
              onTap: () => _open(root, directory: true),
            ),
        ],
      );
    }
    if (_entries.isEmpty) return const Center(child: Text('空目录'));
    return ListView(
      children: [
        for (final entry in _entries)
          ListTile(
            leading: Icon(entry.kind == 'directory' ? Icons.folder_outlined : Icons.description_outlined),
            title: Text(entry.name),
            onTap: () => _open(entry.path, directory: entry.kind == 'directory'),
          ),
      ],
    );
  }
}

class DocumentsPage extends StatelessWidget {
  const DocumentsPage({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('文档')),
      body: DocumentBrowser(
        controller: controller,
        onOpen: (path) async {
          final opened = await controller.openDocumentAt(path);
          if (!context.mounted) return;
          if (!opened) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(controller.documentNotice ?? '打不开')));
            return;
          }
          await Navigator.of(context).push(MaterialPageRoute<void>(
            builder: (_) => DocumentReaderPage(controller: controller),
          ));
        },
      ),
    );
  }
}
