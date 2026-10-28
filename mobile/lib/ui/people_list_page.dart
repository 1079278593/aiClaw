import 'package:flutter/material.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'person_page.dart';

class PeopleListPage extends StatefulWidget {
  const PeopleListPage({
    super.key,
    required this.controller,
    this.sort = 'recent',
    this.initialPane = PersonPane.raw,
    this.embedded = false,
    this.onOpen,
  });

  final AppController controller;
  final String sort;
  final PersonPane initialPane;
  final bool embedded;
  final ValueChanged<PersonSummary>? onOpen;

  @override
  State<PeopleListPage> createState() => _PeopleListPageState();
}

class PersonSummary {
  PersonSummary.fromJson(Map<String, Object?> json)
      : id = '${json['id'] ?? ''}',
        name = '${json['name'] ?? ''}',
        preview = '${json['preview'] ?? '空'}',
        updatedAt = '${json['updatedAt'] ?? ''}';

  final String id;
  final String name;
  final String preview;
  final String updatedAt;
}

class _PeopleListPageState extends State<PeopleListPage> {
  var _people = <PersonSummary>[];
  String? _error;
  var _loading = true;
  late String _sort;

  @override
  void initState() {
    super.initState();
    _sort = widget.sort;
    if (widget.controller.baseUrl.isEmpty) {
      _loading = false;
      _error = '未连接';
      return;
    }
    _load();
  }

  @override
  void didUpdateWidget(PeopleListPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sort != widget.sort) {
      _sort = widget.sort;
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/people', {'sort': _sort}),
        token: widget.controller.token,
      );
      final raw = payload['people'];
      final people = [
        for (final item in raw is List ? raw : const [])
          if (item is Map) PersonSummary.fromJson(Map<String, Object?>.from(item)),
      ];
      if (!mounted) return;
      setState(() { _people = people; _error = null; _loading = false; });
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() { _error = error.message; _loading = false; });
    }
  }

  Future<void> _create() async {
    final created = await showDialog<String>(
      context: context,
      builder: (context) => const _NameDialog(),
    );
    if (created == null || created.trim().isEmpty || !mounted) return;
    try {
      final payload = await widget.controller.api.sendJson(
        'POST',
        apiUri(widget.controller.baseUrl, '/api/people'),
        token: widget.controller.token,
        body: {'name': created.trim()},
      );
      final person = payload['person'];
      if (person is! Map) return;
      final summary = PersonSummary.fromJson(Map<String, Object?>.from(person));
      if (!mounted) return;
      _open(summary);
      await _load();
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  void _open(PersonSummary person) {
    final open = widget.onOpen;
    if (open != null) {
      open(person);
      return;
    }
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => PersonPage(
        controller: widget.controller,
        personId: person.id,
        initialName: person.name,
        initialPane: _sort == 'name' ? PersonPane.profile : widget.initialPane,
      ),
    )).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    final body = _loading
        ? const Center(child: CircularProgressIndicator())
        : _error != null
            ? Center(child: Text(_error!))
            : RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  children: [
                    if (_people.isEmpty) const ListTile(title: Text('还没有人')),
                    for (final person in _people)
                      ListTile(
                        title: Text(person.name),
                        subtitle: Text(person.preview, maxLines: 1, overflow: TextOverflow.ellipsis),
                        onTap: () => _open(person),
                      ),
                  ],
                ),
              );
    if (widget.embedded) {
      return Column(
        children: [
          Row(
            children: [
              _sortButton(),
              const Spacer(),
              IconButton(onPressed: _create, icon: const Icon(Icons.person_add_alt)),
            ],
          ),
          Expanded(child: body),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('人物'), actions: [
        _sortButton(),
        IconButton(onPressed: _create, icon: const Icon(Icons.person_add_alt)),
      ]),
      body: body,
    );
  }

  Widget _sortButton() {
    return TextButton(
      onPressed: () {
        setState(() => _sort = _sort == 'recent' ? 'name' : 'recent');
        _load();
      },
      child: Text(_sort == 'recent' ? '按称呼' : '最近'),
    );
  }
}

class _NameDialog extends StatefulWidget {
  const _NameDialog();

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新建'),
      content: TextField(controller: _name, autofocus: true, decoration: const InputDecoration(labelText: '称呼')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        TextButton(onPressed: () => Navigator.pop(context, _name.text), child: const Text('建立')),
      ],
    );
  }
}
