import 'package:flutter/material.dart';

import '../src/app_controller.dart';

class ConnectPage extends StatefulWidget {
  const ConnectPage({super.key, required this.controller, this.initialError});
  final AppController controller;
  final String? initialError;

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  late final TextEditingController _base = TextEditingController(text: widget.controller.baseUrl);
  late final TextEditingController _token = TextEditingController(text: widget.controller.token);
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _error = widget.initialError;
  }

  @override
  void didUpdateWidget(ConnectPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.initialError != oldWidget.initialError) _error = widget.initialError;
  }

  @override
  void dispose() {
    _base.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await widget.controller.signIn(_base.text, _token.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 32),
            Text('连接 aiClaw', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 8),
            const Text('填写运行主服务的地址。启用 accessToken 时需要一并填写。'),
            const SizedBox(height: 24),
            TextField(
              controller: _base,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: '服务器地址',
                hintText: 'http://192.168.1.10:3000',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _token,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'access token'),
              onSubmitted: (_) => _submit(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? '正在连接' : '连接'),
            ),
          ],
        ),
      ),
    );
  }
}
