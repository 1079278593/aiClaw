import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:image_picker/image_picker.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import '../src/chat_models.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.controller,
    required this.sessionId,
    this.embedded = false,
    this.onHistory,
  });
  final AppController controller;
  final String sessionId;
  final bool embedded;
  final VoidCallback? onHistory;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  Timer? _suggestTimer;
  List<FileHit> _files = [];
  List<CommandHit> _commands = [];

  @override
  void initState() {
    super.initState();
    widget.controller.ensureDraft();
    widget.controller.addListener(_stickToEnd);
    _input.addListener(_scheduleSuggest);
  }

  @override
  void dispose() {
    _suggestTimer?.cancel();
    widget.controller.removeListener(_stickToEnd);
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _stickToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final position = _scroll.position;
      if (position.maxScrollExtent - position.pixels > 160) return;
      _scroll.jumpTo(position.maxScrollExtent);
    });
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final machine = widget.controller.machine;
        final runtime = machine.runtimeOf(widget.sessionId);
        final streaming = runtime.isStreaming;
        final draftImages = widget.controller.draftImages;
        return Scaffold(
          appBar: AppBar(
            automaticallyImplyLeading: !widget.embedded,
            title: Text(runtime.title?.isNotEmpty == true ? runtime.title! : '对话'),
            actions: [
              if (widget.onHistory != null)
                IconButton(onPressed: widget.onHistory, icon: const Icon(Icons.history), tooltip: '历史会话'),
              IconButton(onPressed: () => _pickModel(context), icon: const Icon(Icons.tune), tooltip: '模型'),
              PopupMenuButton<String>(
                onSelected: (value) {
                  if (value == 'compact') _compact();
                  if (value == 'attach') {
                    widget.controller.setAttachDocument(!widget.controller.attachDocument);
                  }
                  if (value == 'image') _pickImage();
                },
                itemBuilder: (context) => [
                  const PopupMenuItem(value: 'image', child: Text('从相册添加图片')),
                  const PopupMenuItem(value: 'compact', child: Text('压缩')),
                  PopupMenuItem(
                    value: 'attach',
                    child: Text(widget.controller.attachDocument ? '关闭附带当前文档' : '附带当前文档'),
                  ),
                ],
              ),
            ],
          ),
          body: Column(
            children: [
              if (!widget.controller.socketConnected) const LinearProgressIndicator(),
              if (machine.connectionError != null)
                _Banner(text: machine.connectionError!, onClose: widget.controller.dismissConnectionError),
              if (runtime.errorMessage != null)
                _Banner(
                  text: runtime.errorMessage!,
                  onClose: () => widget.controller.dismissError(widget.sessionId),
                ),
              Expanded(
                child: GestureDetector(
                  onTap: _clearSuggest,
                  child: ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.all(12),
                    itemCount: runtime.messages.length,
                    itemBuilder: (context, index) => _MessageTile(
                      controller: widget.controller,
                      message: runtime.messages[index],
                      onRestart: () => _truncate(runtime.messages[index]),
                    ),
                  ),
                ),
              ),
              if (_files.isNotEmpty || _commands.isNotEmpty)
                SizedBox(
                  height: 180,
                  child: Material(
                    color: Theme.of(context).colorScheme.surfaceContainerHighest,
                    child: ListView(
                      children: [
                        for (final file in _files)
                          ListTile(
                            title: Text(file.label),
                            subtitle: Text(file.path),
                            onTap: () => _insertAtCursor('@', file.path),
                          ),
                        for (final command in _commands)
                          ListTile(title: Text(command.name), onTap: () => _insertAtCursor('/', command.name)),
                      ],
                    ),
                  ),
                ),
              if (machine.permissionVisible && machine.currentSessionId == widget.sessionId)
                _PermissionBar(controller: widget.controller),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                  child: Column(
                    children: [
                      if (widget.controller.attachDocument && widget.controller.selectedPreviewText != null)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: InputChip(
                            label: Text(widget.controller.selectedPreviewText!, maxLines: 1, overflow: TextOverflow.ellipsis),
                            onDeleted: widget.controller.clearSelectedPreview,
                          ),
                        ),
                      if (draftImages.isNotEmpty)
                        SizedBox(
                          height: 72,
                          child: ListView(
                            scrollDirection: Axis.horizontal,
                            children: [
                              for (final image in draftImages)
                                Padding(
                                  padding: const EdgeInsets.only(right: 8),
                                  child: Stack(
                                    children: [
                                      Image.memory(_bytesOf(image.url), width: 64, height: 64, fit: BoxFit.cover),
                                      Positioned(
                                        right: 0,
                                        top: 0,
                                        child: IconButton(
                                          onPressed: () => widget.controller.removeDraftImage(image),
                                          icon: const Icon(Icons.close, size: 16),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        ),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _input,
                              minLines: 1,
                              maxLines: 5,
                              decoration: const InputDecoration(hintText: '输入消息，@ 选文件，/ 选命令'),
                            ),
                          ),
                          IconButton(
                            onPressed: () {
                              if (streaming) {
                                widget.controller.machine.cancelCurrent();
                                return;
                              }
                              final text = _input.text;
                              if (widget.controller.sendChat(text)) {
                                _input.clear();
                                _clearSuggest();
                              }
                            },
                            icon: Icon(streaming ? Icons.stop : Icons.send),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _clearSuggest() {
    if (_files.isEmpty && _commands.isEmpty) return;
    setState(() {
      _files = [];
      _commands = [];
    });
  }

  void _scheduleSuggest() {
    _suggestTimer?.cancel();
    final text = _input.text;
    final file = RegExp(r'(?:^|\s)@([^\s@]*)$').firstMatch(text);
    final command = RegExp(r'(?:^|\s)/([^\s/]*)$').firstMatch(text);
    if (file == null && command == null) {
      _clearSuggest();
      return;
    }
    _suggestTimer = Timer(const Duration(milliseconds: 200), () async {
      try {
        if (file != null) {
          final hits = await widget.controller.searchFiles(file.group(1) ?? '');
          if (!mounted) return;
          setState(() {
            _files = hits;
            _commands = [];
          });
        } else {
          final hits = await widget.controller.searchCommands(command?.group(1) ?? '');
          if (!mounted) return;
          setState(() {
            _commands = hits;
            _files = [];
          });
        }
      } catch (_) {
        if (mounted) _clearSuggest();
      }
    });
  }

  void _insertAtCursor(String mark, String replacement) {
    final text = _input.text;
    final index = text.lastIndexOf(mark);
    if (index < 0) return;
    _input.value = TextEditingValue(
      text: text.replaceRange(index, text.length, replacement),
      selection: TextSelection.collapsed(offset: index + replacement.length),
    );
    _clearSuggest();
  }

  Future<void> _pickImage() async {
    final file = await ImagePicker().pickImage(source: ImageSource.gallery);
    if (file == null) return;
    final bytes = await file.readAsBytes();
    final mime = file.mimeType ?? 'image/jpeg';
    widget.controller.addDraftImage(ChatImage(url: 'data:$mime;base64,${base64Encode(bytes)}'));
  }

  Future<void> _compact() async {
    final rounds = TextEditingController(text: '4');
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('压缩'),
        content: TextField(
          controller: rounds,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: '保留最近轮数'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, rounds.text.trim()), child: const Text('压缩')),
        ],
      ),
    );
    rounds.dispose();
    final keep = int.tryParse(value ?? '');
    if (keep == null || keep < 0 || !mounted) return;
    try {
      await widget.controller.compactSession(widget.sessionId, keep);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      widget.controller.showSessionError(widget.sessionId, error.message);
    }
  }

  Future<void> _truncate(DisplayMessage message) async {
    if (message.role != 'user' || message.id.startsWith('local-') || message.id.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('从此重开'),
        content: const Text('这条消息之后的内容会被删掉。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('重开')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await widget.controller.truncateSession(widget.sessionId, message.id);
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      widget.controller.showSessionError(widget.sessionId, error.message);
    }
  }

  Future<void> _pickModel(BuildContext context) async {
    final config = widget.controller.config;
    if (config == null) return;
    widget.controller.ensureDraft();
    await showModalBottomSheet<void>(
      context: context,
      builder: (context) {
        return ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final provider = widget.controller.draftProvider;
            final model = config.findModel(provider, widget.controller.draftModel);
            return SafeArea(
              child: ListView(
                children: [
                  for (final id in config.availableProviders)
                    ListTile(
                      title: Text(id),
                      selected: id == provider,
                      onTap: () => widget.controller.chooseProvider(id),
                    ),
                  const Divider(),
                  for (final item in config.modelsFor(provider))
                    ListTile(
                      title: Text(item.label),
                      selected: item.id == widget.controller.draftModel,
                      onTap: () => widget.controller.chooseModel(item.id),
                    ),
                  const Divider(),
                  for (final item in model?.thinking ?? const <ThinkingChoice>[])
                    ListTile(
                      title: Text(item.label),
                      selected: item.id == widget.controller.draftThinking,
                      onTap: () => widget.controller.chooseThinking(item.id),
                    ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

class _PermissionBar extends StatelessWidget {
  const _PermissionBar({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final pending = controller.machine.current?.pendingPermission;
    final name = pending?['toolName'] ?? '工具';
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(child: Text('允许 $name ？')),
            TextButton(onPressed: () => controller.machine.respondPermission(false), child: const Text('拒绝')),
            FilledButton(onPressed: () => controller.machine.respondPermission(true), child: const Text('允许')),
          ],
        ),
      ),
    );
  }
}

class _MessageTile extends StatelessWidget {
  const _MessageTile({required this.controller, required this.message, required this.onRestart});
  final AppController controller;
  final DisplayMessage message;
  final VoidCallback onRestart;

  @override
  Widget build(BuildContext context) {
    final mine = message.role == 'user';
    final showProcess = controller.showProcess;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: mine && !message.id.startsWith('local-') && message.id.isNotEmpty ? onRestart : null,
        child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(12),
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.86),
        decoration: BoxDecoration(
          color: mine
              ? Theme.of(context).colorScheme.primaryContainer
              : Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showProcess && message.reasoning.isNotEmpty) ...[
              Text('推理', style: Theme.of(context).textTheme.labelMedium),
              Text(message.reasoning),
              const SizedBox(height: 8),
            ],
            if (showProcess)
              for (final tool in message.tools) ...[
              Text(tool.name, style: Theme.of(context).textTheme.labelMedium),
              Text(tool.arguments),
              if (tool.result != null)
                Text(tool.result!, style: TextStyle(color: tool.isError ? Theme.of(context).colorScheme.error : null)),
              const SizedBox(height: 8),
            ],
            for (final image in message.images)
              _ChatImage(controller: controller, image: image),
            if (message.text.isNotEmpty)
              mine ? Text(message.text) : MarkdownBody(data: message.text, selectable: true),
          ],
        ),
        ),
      ),
    );
  }
}

class _ChatImage extends StatelessWidget {
  const _ChatImage({required this.controller, required this.image});
  final AppController controller;
  final ChatImage image;

  @override
  Widget build(BuildContext context) {
    if (image.inline && image.url.startsWith('data:')) {
      final bytes = _decodeDataUrl(image.url);
      if (bytes == null) return const Text('图片');
      return Image.memory(bytes, height: 180, fit: BoxFit.contain);
    }
    if (image.inline) return Image.network(image.url, height: 180, fit: BoxFit.contain);
    final path = image.path;
    if (path == null || path.isEmpty) return const Text('图片');
    return FutureBuilder<Uint8List>(
      future: controller.api.getBytes(
        apiUri(controller.baseUrl, '/api/image', {'path': path}),
        token: controller.token,
      ),
      builder: (context, snapshot) {
        if (snapshot.hasData) return Image.memory(snapshot.data!, height: 180, fit: BoxFit.contain);
        if (snapshot.hasError) return const Text('图片加载失败');
        return const SizedBox(height: 48, child: Center(child: CircularProgressIndicator()));
      },
    );
  }
}

Uint8List? _decodeDataUrl(String url) {
  final comma = url.indexOf(',');
  if (comma < 0) return null;
  try {
    return base64Decode(url.substring(comma + 1));
  } catch (_) {
    return null;
  }
}

Uint8List _bytesOf(String url) => _decodeDataUrl(url) ?? Uint8List(0);

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.onClose});
  final String text;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.errorContainer,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          Expanded(child: Text(text)),
          IconButton(onPressed: onClose, icon: const Icon(Icons.close)),
        ],
      ),
    );
  }
}
