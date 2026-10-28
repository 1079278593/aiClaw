import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';

class AccountSettingsPage extends StatefulWidget {
  const AccountSettingsPage({super.key, required this.controller});
  final AppController controller;

  @override
  State<AccountSettingsPage> createState() => _AccountSettingsPageState();
}

class _ProviderRow {
  _ProviderRow({required this.id, required this.label, required this.configured, required this.models});
  final String id;
  final String label;
  final bool configured;
  final List<({String id, String label})> models;
}

class _AccountSettingsPageState extends State<AccountSettingsPage> {
  final _secrets = <String, TextEditingController>{};
  final _cleared = <String>{};
  final _triliumUrl = TextEditingController();
  List<_ProviderRow> _providers = [];
  String _provider = '';
  String _model = '';
  String _accountId = '';
  var _triliumConfigured = false;
  var _tavilyConfigured = false;
  String? _error;
  var _loading = true;
  var _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final controller in _secrets.values) {
      controller.dispose();
    }
    _triliumUrl.dispose();
    super.dispose();
  }

  TextEditingController _secret(String id) {
    return _secrets.putIfAbsent(id, TextEditingController.new);
  }

  Future<void> _load() async {
    final controller = widget.controller;
    try {
      final data = await controller.api.getJson(
        apiUri(controller.baseUrl, '/api/settings/account'),
        token: controller.token,
      );
      final providers = <_ProviderRow>[];
      final raw = data['providers'];
      if (raw is List) {
        for (final item in raw) {
          if (item is! Map) continue;
          final models = <({String id, String label})>[];
          final rawModels = item['models'];
          if (rawModels is List) {
            for (final model in rawModels) {
              if (model is! Map) continue;
              models.add((id: '${model['id'] ?? ''}', label: '${model['label'] ?? model['id'] ?? ''}'));
            }
          }
          providers.add(_ProviderRow(
            id: '${item['id'] ?? ''}',
            label: '${item['label'] ?? item['id'] ?? ''}',
            configured: item['configured'] == true,
            models: models,
          ));
        }
      }
      final trilium = data['trilium'];
      final tavily = data['tavily'];
      if (!mounted) return;
      setState(() {
        _providers = providers;
        _provider = '${data['defaultProvider'] ?? ''}';
        _model = '${data['defaultModel'] ?? ''}';
        _accountId = '${data['accountId'] ?? widget.controller.config?.accountId ?? ''}';
        if (trilium is Map) {
          _triliumUrl.text = '${trilium['baseUrl'] ?? ''}';
          _triliumConfigured = trilium['configured'] == true;
        }
        if (tavily is Map) _tavilyConfigured = tavily['configured'] == true;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.unauthorized ? '凭证无效' : error.message;
        _loading = false;
      });
    }
  }

  _ProviderRow? get _selected {
    for (final provider in _providers) {
      if (provider.id == _provider) return provider;
    }
    return _providers.isEmpty ? null : _providers.first;
  }

  String _statusLabel(String name, String key, bool configured) {
    final filled = configured && !_cleared.contains(key);
    return '$name（${filled ? '已填写' : '未填写'}）';
  }

  Map<String, Object?> _body() {
    final providers = <String, Object?>{};
    for (final provider in _providers) {
      final value = _secretValue(provider.id);
      if (value != null) providers[provider.id] = {'apiKey': value};
    }
    final trilium = <String, Object?>{'baseUrl': _triliumUrl.text.trim()};
    final token = _secretValue('trilium');
    if (token != null) trilium['token'] = token;
    final body = <String, Object?>{
      'defaultProvider': _provider,
      'defaultModel': _model,
      'providers': providers,
      'trilium': trilium,
    };
    final tavily = _secretValue('tavily');
    if (tavily != null) body['tavily'] = {'apiKey': tavily};
    return body;
  }

  String? _secretValue(String key) {
    if (_cleared.contains(key)) return '';
    final value = _secrets[key]?.text.trim() ?? '';
    return value.isEmpty ? null : value;
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final controller = widget.controller;
    try {
      await controller.api.sendJson(
        'PUT',
        apiUri(controller.baseUrl, '/api/settings/account'),
        token: controller.token,
        body: _body(),
      );
      await controller.refreshAfterAccountChange();
      if (!mounted) return;
      Navigator.of(context).pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _rotateToken() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('轮换访问令牌'),
        content: const Text('旧令牌会立即失效。其他设备需要改用新令牌。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('继续')),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final controller = widget.controller;
    try {
      final data = await controller.api.sendJson(
        'POST',
        apiUri(controller.baseUrl, '/api/account/token/rotate'),
        token: controller.token,
        body: {},
      );
      final next = data['token'];
      if (next is! String || next.isEmpty) throw ApiException(500, '没有返回新令牌');
      await controller.adoptAccessToken(next);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('新访问令牌'),
          content: SelectableText(next),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('我已复制')),
          ],
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final selected = _selected;
    return Scaffold(
      appBar: AppBar(
        title: Text(_accountId.isEmpty ? '服务与模型' : '服务与模型 · $_accountId'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const Text('只保存到当前账号。密钥留空表示不修改。'),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  initialValue: _providers.any((item) => item.id == _provider) ? _provider : null,
                  decoration: const InputDecoration(labelText: '默认模型服务'),
                  items: [
                    for (final provider in _providers)
                      DropdownMenuItem(value: provider.id, child: Text(provider.label)),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    final next = _providers.where((item) => item.id == value).firstOrNull;
                    setState(() {
                      _provider = value;
                      _model = next?.models.isNotEmpty == true ? next!.models.first.id : '';
                    });
                  },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: selected?.models.any((item) => item.id == _model) == true ? _model : null,
                  decoration: const InputDecoration(labelText: '默认模型'),
                  items: [
                    for (final model in selected?.models ?? const <({String id, String label})>[])
                      DropdownMenuItem(value: model.id, child: Text(model.label)),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _model = value);
                  },
                ),
                const SizedBox(height: 24),
                Text('模型密钥', style: Theme.of(context).textTheme.titleMedium),
                for (final provider in _providers) ...[
                  const SizedBox(height: 12),
                  TextField(
                    controller: _secret(provider.id),
                    obscureText: true,
                    decoration: InputDecoration(
                      labelText: _statusLabel(provider.label, provider.id, provider.configured),
                    ),
                    onChanged: (_) => setState(() => _cleared.remove(provider.id)),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: () => setState(() {
                        _secret(provider.id).clear();
                        _cleared.add(provider.id);
                      }),
                      child: const Text('清除'),
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                Text('Trilium', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 12),
                TextField(
                  controller: _triliumUrl,
                  decoration: const InputDecoration(labelText: '地址'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _secret('trilium'),
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: _statusLabel('ETAPI 令牌', 'trilium', _triliumConfigured),
                  ),
                  onChanged: (_) => setState(() => _cleared.remove('trilium')),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () => setState(() {
                      _secret('trilium').clear();
                      _cleared.add('trilium');
                    }),
                    child: const Text('清除'),
                  ),
                ),
                Text('网页搜索', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 12),
                TextField(
                  controller: _secret('tavily'),
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: _statusLabel('Tavily', 'tavily', _tavilyConfigured),
                  ),
                  onChanged: (_) => setState(() => _cleared.remove('tavily')),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () => setState(() {
                      _secret('tavily').clear();
                      _cleared.add('tavily');
                    }),
                    child: const Text('清除'),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ],
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? '正在保存' : '保存'),
                ),
                const SizedBox(height: 28),
                Text('访问令牌', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                const Text('轮换后旧令牌立即失效。本机会改用新令牌，其他设备需要重新填写。'),
                const SizedBox(height: 12),
                OutlinedButton(
                  onPressed: _saving ? null : _rotateToken,
                  child: const Text('轮换访问令牌'),
                ),
              ],
            ),
    );
  }
}
