import 'package:flutter/material.dart';

import 'src/app_controller.dart';
import 'ui/ai_theme.dart';
import 'ui/connect_page.dart';
import 'ui/shell_page.dart';

final navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AppController();
  await controller.loadSaved();
  runApp(AiClawApp(controller: controller));
}

class AiClawApp extends StatefulWidget {
  const AiClawApp({super.key, required this.controller});
  final AppController controller;

  @override
  State<AiClawApp> createState() => _AiClawAppState();
}

class _AiClawAppState extends State<AiClawApp> {
  late bool _ready;
  late String _chrome;

  @override
  void initState() {
    super.initState();
    _ready = widget.controller.ready;
    _chrome = _chromeKey();
    widget.controller.addListener(_onController);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onController);
    widget.controller.dispose();
    super.dispose();
  }

  void _onController() {
    final chrome = _chromeKey();
    if (chrome != _chrome) {
      _chrome = chrome;
      setState(() {});
    }
    if (widget.controller.ready == _ready) return;
    _ready = widget.controller.ready;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      navigatorKey.currentState?.pushAndRemoveUntil(
        MaterialPageRoute<void>(builder: (_) => _rootPage()),
        (_) => false,
      );
    });
  }

  String _chromeKey() {
    final controller = widget.controller;
    return '${controller.themeId}|${controller.serif}|${controller.fontSize}';
  }

  Widget _rootPage() {
    if (widget.controller.ready) {
      return ShellPage(controller: widget.controller);
    }
    return ConnectPage(
      controller: widget.controller,
      initialError: widget.controller.connectError,
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navigatorKey,
      title: 'aiClaw',
      theme: aiTheme(widget.controller),
      home: _rootPage(),
    );
  }
}
