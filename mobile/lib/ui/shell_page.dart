import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'ai_theme.dart';
import 'chat_page.dart';
import 'document_browser.dart';
import 'document_reader.dart';
import 'more_page.dart';
import 'session_list_page.dart';

const _handleWidth = 16.0;
const _minDocWidth = 140.0;
const _maxDocWidth = 480.0;
const _minChatWidth = 200.0;
const _maxChatWidth = 640.0;
const _minReaderWidth = 240.0;
const _minSideWidth = 160.0;

class _ColumnHandle extends StatelessWidget {
  const _ColumnHandle({required this.onDrag, required this.onDragEnd});

  final ValueChanged<double> onDrag;
  final VoidCallback onDragEnd;

  @override
  Widget build(BuildContext context) {
    final line = Theme.of(context).colorScheme.outlineVariant;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onHorizontalDragUpdate: (details) => onDrag(details.delta.dx),
      onHorizontalDragEnd: (_) => onDragEnd(),
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeColumn,
        child: SizedBox(
          width: _handleWidth,
          child: Stack(
            fit: StackFit.expand,
            children: [
              Positioned(
                top: 0,
                bottom: 0,
                left: (_handleWidth - 1) / 2,
                width: 1,
                child: ColoredBox(color: line),
              ),
              Center(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: line),
                  ),
                  child: const SizedBox(width: 10, height: 36),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ShellPage extends StatefulWidget {
  const ShellPage({super.key, required this.controller});
  final AppController controller;

  @override
  State<ShellPage> createState() => _ShellPageState();
}

class _ShellPageState extends State<ShellPage> {
  var _tab = 0;
  var _sidebar = 0;
  double _docWidth = 280;
  double _chatWidth = 420;
  double _sideWidth = 300;

  @override
  void initState() {
    super.initState();
    _restore();
    _loadWidths();
  }

  Future<void> _loadWidths() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!mounted) return;
      setState(() {
        _docWidth = prefs.getDouble('ipad-doc-width') ?? _docWidth;
        _chatWidth = prefs.getDouble('ipad-chat-width') ?? _chatWidth;
        _sideWidth = prefs.getDouble('ipad-side-width') ?? _sideWidth;
      });
    } catch (_) {}
  }

  Future<void> _saveWidths() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble('ipad-doc-width', _docWidth);
    await prefs.setDouble('ipad-chat-width', _chatWidth);
    await prefs.setDouble('ipad-side-width', _sideWidth);
  }

  Future<void> _restore() async {
    try {
      await widget.controller.refreshSessions();
      final lastId = await widget.controller.lastActiveSessionId();
      if (!mounted || lastId == null) return;
      final exists = widget.controller.sessions.any((session) => session.id == lastId);
      if (exists && widget.controller.machine.currentSessionId == null) {
        widget.controller.openSession(lastId);
      }
    } on ApiException {
      // 会话页自己展示错误。
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!isTablet(context)) return _phone();
    if (isWideTablet(context)) return _wide();
    return _portrait();
  }

  Widget _phone() {
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          SessionListPage(controller: widget.controller),
          DocumentsPage(controller: widget.controller),
          MorePage(controller: widget.controller),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (index) => setState(() => _tab = index),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: '聊天'),
          NavigationDestination(icon: Icon(Icons.folder_outlined), label: '文档'),
          NavigationDestination(icon: Icon(Icons.more_horiz), label: '更多'),
        ],
      ),
    );
  }

  Widget _portrait() {
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final side = _sideWidth.clamp(_minSideWidth, (constraints.maxWidth * 0.5).clamp(_minSideWidth, 460.0)).toDouble();
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(width: side, child: _portraitSidebar()),
                _ColumnHandle(
                  onDrag: (dx) => setState(() => _sideWidth = side + dx),
                  onDragEnd: _saveWidths,
                ),
                Expanded(child: _sidebar == 0 ? _chatOrEmpty() : DocumentReaderPage(controller: widget.controller, embedded: true)),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _portraitSidebar() {
    return Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: SegmentedButton<int>(
                      segments: const [
                        ButtonSegment(value: 0, label: Text('会话')),
                        ButtonSegment(value: 1, label: Text('文档')),
                      ],
                      selected: {_sidebar},
                      onSelectionChanged: (value) => setState(() => _sidebar = value.first),
                    ),
                  ),
                  Expanded(child: _sidebar == 0 ? _sessionSidebar(push: false) : _docSidebar()),
                  ListTile(
                    leading: const Icon(Icons.tune),
                    title: const Text('更多'),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                      builder: (_) => MorePage(controller: widget.controller),
                    )),
                  ),
                ],
    );
  }

  Widget _wide() {
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            const handle = _handleWidth;
            const minMiddle = _minReaderWidth;
            final total = constraints.maxWidth;
            final maxDoc = (total - _minChatWidth - handle * 2 - minMiddle).clamp(_minDocWidth, _maxDocWidth).toDouble();
            final doc = _docWidth.clamp(_minDocWidth, maxDoc).toDouble();
            final maxChat = (total - doc - handle * 2 - minMiddle).clamp(_minChatWidth, _maxChatWidth).toDouble();
            final chat = _chatWidth.clamp(_minChatWidth, maxChat).toDouble();
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(width: doc, child: _docSidebar(footer: true)),
                _ColumnHandle(
                  onDrag: (dx) => setState(() => _docWidth = doc + dx),
                  onDragEnd: _saveWidths,
                ),
                Expanded(child: DocumentReaderPage(controller: widget.controller, embedded: true)),
                _ColumnHandle(
                  onDrag: (dx) => setState(() => _chatWidth = chat - dx),
                  onDragEnd: _saveWidths,
                ),
                SizedBox(width: chat, child: _chatOrEmpty(showHistory: true)),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _docSidebar({bool footer = false}) {
    return Column(
      children: [
        Expanded(
          child: DocumentBrowser(
            controller: widget.controller,
            onOpen: (path) async {
              final opened = await widget.controller.openDocumentAt(path);
              if (!mounted || opened) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(widget.controller.documentNotice ?? '打不开')),
              );
            },
          ),
        ),
        if (footer)
          ListTile(
            leading: const Icon(Icons.tune),
            title: const Text('更多'),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => MorePage(controller: widget.controller),
            )),
          ),
      ],
    );
  }

  Widget _sessionSidebar({required bool push}) {
    return SessionListPage(controller: widget.controller, pushChat: push, restoreLast: false);
  }

  Widget _chatOrEmpty({bool showHistory = false}) {
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final id = widget.controller.machine.currentSessionId;
        if (id == null) {
          return Center(
            child: FilledButton(
              onPressed: () async {
                final created = await widget.controller.createSession();
                if (created.id.isNotEmpty) widget.controller.openSession(created.id);
              },
              child: const Text('新建对话'),
            ),
          );
        }
        return ChatPage(
          controller: widget.controller,
          sessionId: id,
          embedded: true,
          onHistory: showHistory ? _showHistory : null,
        );
      },
    );
  }

  Future<void> _showHistory() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) {
        return FractionallySizedBox(
          heightFactor: 0.75,
          child: SessionListPage(controller: widget.controller, pushChat: false, restoreLast: false),
        );
      },
    );
  }
}
