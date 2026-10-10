import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../src/app_controller.dart';

class DocumentReaderPage extends StatelessWidget {
  const DocumentReaderPage({super.key, required this.controller, this.embedded = false});
  final AppController controller;
  final bool embedded;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final doc = controller.openDocument;
        if (doc == null) {
          return embedded
              ? const Center(child: Text('从左侧打开一篇文档'))
              : Scaffold(appBar: AppBar(title: const Text('文档')), body: const Center(child: Text('未打开文档')));
        }
        return _Reader(controller: controller, document: doc, embedded: embedded);
      },
    );
  }
}

class _Reader extends StatefulWidget {
  const _Reader({required this.controller, required this.document, required this.embedded});
  final AppController controller;
  final OpenDocument document;
  final bool embedded;

  @override
  State<_Reader> createState() => _ReaderState();
}

class _ReaderState extends State<_Reader> {
  late final TextEditingController _text = TextEditingController(text: widget.document.content);
  var _preview = true;
  String? _error;

  @override
  void didUpdateWidget(_Reader oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.document.path != widget.document.path || oldWidget.document.content != widget.document.content) {
      _text.text = widget.document.content;
      _preview = true;
      _error = null;
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final error = await widget.controller.saveDocument(widget.document.path, _text.text);
    if (!mounted) return;
    setState(() => _error = error);
  }

  @override
  Widget build(BuildContext context) {
    final doc = widget.document;
    final body = Column(
      children: [
        if (_error != null)
          Material(color: Theme.of(context).colorScheme.errorContainer, child: ListTile(title: Text(_error!))),
        if (doc.kind == 'text')
          Expanded(child: _preview ? _markdown(doc.content) : _editor()),
        if (doc.kind == 'image') Expanded(child: Center(child: _image(doc.content))),
        if (doc.kind != 'text' && doc.kind != 'image')
          Expanded(child: Padding(padding: const EdgeInsets.all(24), child: Text(doc.content))),
      ],
    );
    final actions = [
      if (doc.kind == 'text')
        IconButton(
          tooltip: _preview ? '编辑' : '预览',
          onPressed: () => setState(() => _preview = !_preview),
          icon: Icon(_preview ? Icons.edit_outlined : Icons.visibility_outlined),
        ),
      if (doc.canSave && !_preview)
        IconButton(tooltip: '保存', onPressed: _save, icon: const Icon(Icons.check)),
      if (doc.kind == 'text' && !_preview)
        IconButton(
          tooltip: '附加选区',
          onPressed: () {
            final selection = _text.selection;
            if (!selection.isValid || selection.isCollapsed) return;
            widget.controller.setSelectedPreview(selection.textInside(_text.text));
          },
          icon: const Icon(Icons.format_quote),
        ),
    ];
    if (widget.embedded) {
      return Column(
        children: [
          ListTile(title: Text(doc.displayTitle), trailing: Row(mainAxisSize: MainAxisSize.min, children: actions)),
          Expanded(child: body),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(doc.displayTitle), actions: actions),
      body: body,
    );
  }

  Widget _markdown(String content) {
    return Markdown(
      data: content,
      selectable: true,
      padding: const EdgeInsets.all(20),
    );
  }

  Widget _editor() {
    return TextField(
      controller: _text,
      maxLines: null,
      expands: true,
      textAlignVertical: TextAlignVertical.top,
      decoration: const InputDecoration(contentPadding: EdgeInsets.all(20), border: InputBorder.none),
    );
  }

  Widget _image(String dataUrl) {
    final comma = dataUrl.indexOf(',');
    if (comma < 0) return const Text('图片');
    try {
      final bytes = base64Decode(dataUrl.substring(comma + 1));
      return Image.memory(Uint8List.fromList(bytes), fit: BoxFit.contain);
    } catch (_) {
      return const Text('图片');
    }
  }
}
