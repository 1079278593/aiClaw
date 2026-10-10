import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';

class MorePage extends StatelessWidget {
  const MorePage({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('更多')),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          return ListView(
            children: [
              ListTile(title: const Text('服务器'), subtitle: Text(controller.baseUrl)),
              const ListTile(title: Text('主题')),
              RadioGroup<String>(
                groupValue: controller.themeId,
                onChanged: (value) {
                  if (value != null) controller.setTheme(value);
                },
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final item in const [('light', '卡其'), ('daylight', '明亮'), ('monochrome', '墨灰')])
                      RadioListTile<String>(title: Text(item.$2), value: item.$1),
                  ],
                ),
              ),
              SwitchListTile(
                title: const Text('衬线字体'),
                subtitle: const Text('关闭时使用系统无衬线'),
                value: controller.serif,
                onChanged: controller.setSerif,
              ),
              ListTile(
                title: const Text('字号'),
                subtitle: Slider(
                  min: 12,
                  max: 22,
                  divisions: 10,
                  label: controller.fontSize.round().toString(),
                  value: controller.fontSize.clamp(12, 22).toDouble(),
                  onChanged: controller.setFontSize,
                ),
              ),
              SwitchListTile(
                title: const Text('展开推理与工具过程'),
                value: controller.showProcess,
                onChanged: controller.setShowProcess,
              ),
              SwitchListTile(
                title: const Text('允许写入'),
                subtitle: const Text('关闭时，写文件工具会逐次询问'),
                value: controller.writeEnabled,
                onChanged: controller.setWriteEnabled,
              ),
              ListTile(
                title: const Text('用量'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                  builder: (_) => UsagePage(controller: controller),
                )),
              ),
              ListTile(title: const Text('退出并清除令牌'), onTap: controller.logout),
            ],
          );
        },
      ),
    );
  }
}

class UsagePage extends StatefulWidget {
  const UsagePage({super.key, required this.controller});
  final AppController controller;

  @override
  State<UsagePage> createState() => _UsagePageState();
}

class _UsagePageState extends State<UsagePage> {
  var _days = 7;
  var _tab = 0;
  String? _error;
  List<UsageDay> _daily = [];
  List<UsageStat> _stats = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final daily = await widget.controller.loadUsageDaily(_days);
      final stats = await widget.controller.loadUsageStats();
      if (!mounted) return;
      setState(() {
        _daily = daily;
        _stats = stats;
        _error = null;
      });
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _flush() async {
    try {
      await widget.controller.flushUsage();
      await _load();
    } on ApiException catch (error) {
      if (!mounted || error.unauthorized) return;
      setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('用量'),
        actions: [IconButton(onPressed: _flush, icon: const Icon(Icons.refresh), tooltip: '刷新统计')],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 0, label: Text('按日')),
                ButtonSegment(value: 1, label: Text('汇总')),
              ],
              selected: {_tab},
              onSelectionChanged: (value) => setState(() => _tab = value.first),
            ),
          ),
          if (_tab == 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: SegmentedButton<int>(
                segments: const [
                  ButtonSegment(value: 7, label: Text('7 天')),
                  ButtonSegment(value: 30, label: Text('30 天')),
                ],
                selected: {_days},
                onSelectionChanged: (value) {
                  setState(() => _days = value.first);
                  _load();
                },
              ),
            ),
          if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!)),
          Expanded(
            child: ListView(
              children: [
                if (_tab == 0)
                  for (final day in _daily)
                    ListTile(
                      title: Text(day.date),
                      subtitle: Text('${day.totalTokens.toStringAsFixed(0)} tokens · ${day.totalCost.toStringAsFixed(4)}'),
                    ),
                if (_tab == 1)
                  for (final stat in _stats)
                    ListTile(
                      title: Text('${stat.provider} / ${stat.model}'),
                      subtitle: Text(
                        '输入 ${stat.inputTokens.toStringAsFixed(0)} · 输出 ${stat.outputTokens.toStringAsFixed(0)} · 计费 ${stat.billingOutputTokens.toStringAsFixed(0)} · ${stat.cost.toStringAsFixed(4)}',
                      ),
                    ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
