import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'ai_theme.dart';
import 'chat_page.dart';
import 'document_browser.dart';
import 'document_reader.dart';
import 'more_page.dart';
import 'session_list_page.dart';

class ShellPage extends StatefulWidget {
  const ShellPage({super.key, required this.controller});
  final AppController controller;

  @override
  State<ShellPage> createState() => _ShellPageState();
}

class _ShellPageState extends State<ShellPage> {
  var _tab = 0;
  var _sidebar = 0;

  @override
  void initState() {
    super.initState();
    _restore();
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
        child: Row(
          children: [
            SizedBox(
              width: 300,
              child: Column(
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
              ),
            ),
            const VerticalDivider(width: 1),
            Expanded(child: _sidebar == 0 ? _chatOrEmpty() : DocumentReaderPage(controller: widget.controller, embedded: true)),
          ],
        ),
      ),
    );
  }

  Widget _wide() {
    return Scaffold(
      body: SafeArea(
        child: Row(
          children: [
            SizedBox(width: 280, child: _docSidebar(footer: true)),
            const VerticalDivider(width: 1),
            Expanded(child: DocumentReaderPage(controller: widget.controller, embedded: true)),
            const VerticalDivider(width: 1),
            SizedBox(width: 420, child: _chatOrEmpty(showHistory: true)),
          ],
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
