import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:image_picker/image_picker.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'chat_page.dart';

enum PersonPane { raw, digest, profile, consult }

class PersonPage extends StatefulWidget {
  const PersonPage({
    super.key,
    required this.controller,
    required this.personId,
    required this.initialName,
    this.initialPane = PersonPane.raw,
    this.embedded = false,
    this.includeConsult = false,
    this.onConsultChanged,
  });

  final AppController controller;
  final String personId;
  final String initialName;
  final PersonPane initialPane;
  final bool embedded;
  final bool includeConsult;
  final ValueChanged<PersonConsult>? onConsultChanged;

  @override
  State<PersonPage> createState() => _PersonPageState();
}

class _RawEntry {
  _RawEntry.fromJson(Map<String, Object?> json)
    : id = '${json['id'] ?? ''}',
      at = '${json['at'] ?? ''}',
      kind = '${json['kind'] ?? ''}',
      speaker = json['speaker'] as String?,
      text = '${json['text'] ?? ''}';

  final String id;
  final String at;
  final String kind;
  final String? speaker;
  final String text;
}

/// 把这一轮识别接到听写开始前的文字后面，并把光标放在末尾，输入框才会跟着滚下去。
TextEditingValue speechFieldValue(String base, String recognized) {
  final text = recognized.isEmpty
      ? base
      : base.isEmpty
      ? recognized
      : '$base$recognized';
  return TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: text.length),
  );
}

/// 识别把字接到末尾之后，输入框不会自己滚。下一帧再拉到最后一行。
void revealSpeechTail(ScrollController scroll) {
  if (!scroll.hasClients) return;
  final position = scroll.position;
  if (position.maxScrollExtent <= position.pixels) return;
  position.jumpTo(position.maxScrollExtent);
}

/// iOS 给的是分贝，安静时远小于 0。Android 的响度大约在 -2 到 10。
double speechLevel(double level) {
  if (level.isNaN || level.isInfinite) return 0;
  final normalized = level < -2 ? (level + 50) / 50 : (level + 2) / 12;
  if (normalized.isNaN || normalized.isInfinite) return 0;
  return normalized.clamp(0, 1);
}

class _PersonPageState extends State<PersonPage>
    with SingleTickerProviderStateMixin {
  final _input = TextEditingController();
  final _inputScroll = ScrollController();
  final _inputFocus = FocusNode();
  final _profileEditor = TextEditingController();
  final _speech = SpeechToText();
  final _soundLevel = ValueNotifier<double>(0);
  late final AnimationController _pulse;
  var _pane = PersonPane.raw;
  var _name = '';
  var _profile = '';
  var _digest = '';
  String? _organizedAt;
  var _entries = <_RawEntry>[];
  var _hasMore = false;
  var _saving = false;
  var _listening = false;
  var _speechPartial = false;
  var _commitSpeech = false;
  var _speechBase = '';
  var _closed = false;
  var _tailScheduled = false;
  String? _error;
  String? _selectedText;
  String? _selectedPath;
  var _organizePending = false;

  PersonDraft get _draft => widget.controller.draftForPerson(widget.personId);

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    );
    _name = widget.initialName;
    _pane = widget.initialPane;
    _input.text = _draft.text;
    _input.addListener(_rememberDraft);
    widget.controller.addListener(_onController);
    _load();
  }

  @override
  void dispose() {
    _closed = true;
    _pulse.dispose();
    _soundLevel.dispose();
    _inputScroll.dispose();
    _inputFocus.dispose();
    if (_speech.isListening) _speech.cancel();
    widget.controller.removeListener(_onController);
    _input.dispose();
    _profileEditor.dispose();
    super.dispose();
  }

  void _rememberDraft() {
    if (_speechPartial) return;
    _draft.text = _input.text;
  }

  void _onController() {
    final streaming = widget.controller.machine.current?.isStreaming == true;
    if (_organizePending && !streaming) {
      _organizePending = false;
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final detail = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/people/${widget.personId}'),
        token: widget.controller.token,
      );
      final person = detail['person'];
      final page = await widget.controller.api.getJson(
        apiUri(
          widget.controller.baseUrl,
          '/api/people/${widget.personId}/entries',
        ),
        token: widget.controller.token,
      );
      if (!mounted) return;
      setState(() {
        if (person is Map) {
          _name = '${person['name'] ?? _name}';
          _organizedAt = person['organizedAt'] as String?;
        }
        _profile = '${detail['profile'] ?? ''}';
        _digest = '${detail['digest'] ?? ''}';
        if (_profileEditor.text != _profile) _profileEditor.text = _profile;
        _entries = _readEntries(page['entries']);
        _hasMore = page['hasMore'] == true;
        _error = null;
      });
      _publish();
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error.message);
    }
  }

  Future<void> _loadOlder() async {
    if (!_hasMore || _entries.isEmpty) return;
    final page = await widget.controller.api.getJson(
      apiUri(
        widget.controller.baseUrl,
        '/api/people/${widget.personId}/entries',
        {'before': _entries.first.id},
      ),
      token: widget.controller.token,
    );
    if (!mounted) return;
    setState(() {
      _entries = [..._readEntries(page['entries']), ..._entries];
      _hasMore = page['hasMore'] == true;
    });
  }

  List<_RawEntry> _readEntries(Object? raw) => [
    for (final item in raw is List ? raw : const [])
      if (item is Map) _RawEntry.fromJson(Map<String, Object?>.from(item)),
  ];

  bool get _canOrganize {
    if (_entries.isEmpty) return false;
    final cursor = _organizedAt;
    if (cursor == null || cursor.isEmpty) return true;
    return _entries.any((entry) => entry.at.compareTo(cursor) > 0);
  }

  PersonConsult _currentConsult() {
    final viewingRaw = _pane == PersonPane.raw;
    final viewingDigest = _pane == PersonPane.digest;
    final path = viewingRaw
        ? 'inputs/people/${widget.personId}/entries.jsonl'
        : viewingDigest
        ? 'inputs/people/${widget.personId}/digest.md'
        : _selectedText == null
        ? null
        : _selectedPath;
    return PersonConsult(
      personId: widget.personId,
      name: _name,
      canOrganize: _canOrganize,
      previewPath: path,
      selectedText: _selectedText,
    );
  }

  void _publish() => widget.onConsultChanged?.call(_currentConsult());

  Future<void> _send() async {
    if (_saving) return;
    if (_listening) await _endSpeech(commit: true);
    final text = _input.text;
    if (text.trim().isEmpty) return;
    setState(() => _saving = true);
    try {
      await widget.controller.api.sendJson(
        'POST',
        apiUri(
          widget.controller.baseUrl,
          '/api/people/${widget.personId}/entries',
        ),
        token: widget.controller.token,
        body: {
          'kind': _draft.note ? 'note' : 'line',
          'text': text,
          if (!_draft.note) 'speaker': _draft.mine ? 'me' : 'them',
        },
      );
      _input.clear();
      _draft.text = '';
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _listen() async {
    if (_listening) {
      await _endSpeech(commit: true);
      return;
    }
    var available = false;
    try {
      available = await _speech.initialize(
        onStatus: _onSpeechStatus,
        onError: _onSpeechError,
      );
    } catch (_) {
      available = false;
    }
    if (!available) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('需要语音识别权限')));
      }
      return;
    }
    _speechBase = _input.text;
    _commitSpeech = false;
    _inputFocus.requestFocus();
    _setListening(true);
    try {
      await _speech.listen(
        listenOptions: SpeechListenOptions(
          localeId: 'zh_CN',
          listenMode: ListenMode.dictation,
          partialResults: true,
        ),
        onResult: _onSpeechResult,
        onSoundLevelChange: (level) {
          if (!_closed) _soundLevel.value = level;
        },
      );
    } catch (_) {
      _settleSpeech(commit: false);
    }
  }

  void _onSpeechResult(SpeechRecognitionResult result) {
    if (_closed) return;
    _speechPartial = !result.finalResult;
    final next = speechFieldValue(_speechBase, result.recognizedWords);
    _input.value = next;
    _scheduleSpeechTail();
    if (result.finalResult) {
      _speechPartial = false;
      _draft.text = next.text;
    }
  }

  void _scheduleSpeechTail() {
    if (_tailScheduled) return;
    _tailScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _tailScheduled = false;
      if (_closed) return;
      revealSpeechTail(_inputScroll);
    });
  }

  void _onSpeechStatus(String status) {
    if (_closed || !mounted) return;
    if (status == SpeechToText.listeningStatus) {
      _setListening(true);
      return;
    }
    if (_listening) _settleSpeech(commit: _commitSpeech || !_speechPartial);
  }

  void _onSpeechError(SpeechRecognitionError error) {
    if (_closed || !mounted || !error.permanent || !_listening) return;
    _settleSpeech(commit: _commitSpeech);
  }

  Future<void> _endSpeech({required bool commit}) async {
    _commitSpeech = commit;
    if (_speech.isListening) await _speech.stop();
    if (!_closed && _listening) _settleSpeech(commit: commit);
  }

  void _settleSpeech({required bool commit}) {
    if (_closed) return;
    if (!commit && _speechPartial) {
      _input.value = speechFieldValue(_speechBase, '');
    }
    _speechPartial = false;
    _commitSpeech = false;
    _draft.text = _input.text;
    _setListening(false);
  }

  void _setListening(bool value) {
    if (_closed) return;
    if (_listening != value) setState(() => _listening = value);
    if (value) {
      if (!_pulse.isAnimating) _pulse.repeat(reverse: true);
    } else {
      _pulse.stop();
      _pulse.value = 0;
      _soundLevel.value = 0;
    }
  }

  Future<void> _pickImages() async {
    widget.controller.ensureDraft();
    final config = widget.controller.config;
    final model = config?.findModel(
      widget.controller.draftProvider,
      widget.controller.draftModel,
    );
    if (model?.vision != true) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('请切换到视觉模型后再识别')));
      }
      return;
    }
    final files = await ImagePicker().pickMultiImage();
    if (files.isEmpty || !mounted) return;
    if (files.length > 20) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('一次最多 20 张')));
      return;
    }
    if (_input.text.trim().isNotEmpty) await _send();
    final images = <({String filename, Uint8List bytes, String mime})>[];
    for (final file in files) {
      final name = file.name;
      final lower = name.toLowerCase();
      final mime = lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.gif')
          ? 'image/gif'
          : lower.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
      images.add((filename: name, bytes: await file.readAsBytes(), mime: mime));
    }
    try {
      final payload = await widget.controller.api.postMultipart(
        apiUri(
          widget.controller.baseUrl,
          '/api/people/${widget.personId}/recognize',
        ),
        token: widget.controller.token,
        fields: {
          'provider': widget.controller.draftProvider,
          'model': widget.controller.draftModel,
        },
        files: images,
      );
      final results = payload['results'];
      if (results is List && mounted) {
        final errors = [
          for (final item in results)
            if (item is Map && item['ok'] != true) '${item['error'] ?? '识别失败'}',
        ];
        if (errors.isNotEmpty) {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(errors.join('、'))));
        }
      }
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  Future<void> _rename() async {
    final next = await showDialog<String>(
      context: context,
      builder: (context) =>
          _TextDialog(title: '称呼', initial: _name, action: '保存'),
    );
    if (next == null || next.trim().isEmpty) return;
    try {
      await widget.controller.api.sendJson(
        'PATCH',
        apiUri(widget.controller.baseUrl, '/api/people/${widget.personId}'),
        token: widget.controller.token,
        body: {'name': next.trim()},
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  Future<void> _editEntry(_RawEntry entry) async {
    final saved = await showDialog<_EntryEdit>(
      context: context,
      builder: (context) => _EntryEditDialog(entry: entry),
    );
    if (saved == null) return;
    try {
      await widget.controller.api.sendJson(
        'PATCH',
        apiUri(
          widget.controller.baseUrl,
          '/api/people/${widget.personId}/entries/${entry.id}',
        ),
        token: widget.controller.token,
        body: {
          'text': saved.text,
          if (entry.kind == 'line') 'speaker': saved.speaker,
        },
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  Future<void> _deleteEntry(_RawEntry entry) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: const Text('删除这条'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await widget.controller.api.sendJson(
      'DELETE',
      apiUri(
        widget.controller.baseUrl,
        '/api/people/${widget.personId}/entries/${entry.id}',
      ),
      token: widget.controller.token,
    );
    await _load();
  }

  Future<void> _saveProfile(String markdown) async {
    try {
      await widget.controller.api.sendJson(
        'PUT',
        apiUri(widget.controller.baseUrl, '/api/documents/content'),
        token: widget.controller.token,
        body: {
          'path': 'inputs/people/${widget.personId}/profile.md',
          'content': markdown,
        },
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }

  void _setPane(PersonPane pane) {
    setState(() => _pane = pane);
    _publish();
  }

  Future<void> _ensureSession() async {
    if (widget.controller.machine.currentSessionId != null) return;
    final created = await widget.controller.createSession();
    if (created.id.isNotEmpty) widget.controller.openSession(created.id);
  }

  @override
  Widget build(BuildContext context) {
    final body = _error != null ? Center(child: Text(_error!)) : _body();
    if (widget.embedded) {
      return Column(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                TextButton(
                  onPressed: () => _setPane(PersonPane.raw),
                  child: const Text('原文'),
                ),
                TextButton(
                  onPressed: () => _setPane(PersonPane.digest),
                  child: const Text('历史简报'),
                ),
                TextButton(
                  onPressed: () => _setPane(PersonPane.profile),
                  child: const Text('档案'),
                ),
                if (widget.includeConsult)
                  TextButton(
                    onPressed: () async {
                      await _ensureSession();
                      if (!mounted) return;
                      _setPane(PersonPane.consult);
                    },
                    child: const Text('咨询'),
                  ),
              ],
            ),
          ),
          Expanded(child: body),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: GestureDetector(onTap: _rename, child: Text(_name)),
        actions: [
          TextButton(
            onPressed: () => setState(() {
              _pane = PersonPane.digest;
              _publish();
            }),
            child: const Text('历史简报'),
          ),
          TextButton(
            onPressed: () => setState(() {
              _pane = PersonPane.profile;
              _publish();
            }),
            child: const Text('档案'),
          ),
          TextButton(
            onPressed: () async {
              await _ensureSession();
              if (!mounted) return;
              setState(() => _pane = PersonPane.consult);
              _publish();
            },
            child: const Text('咨询'),
          ),
        ],
      ),
      body: body,
    );
  }

  Widget _body() {
    return switch (_pane) {
      PersonPane.digest => _digestPane(),
      PersonPane.profile => _profilePane(),
      PersonPane.consult => _consultPane(),
      PersonPane.raw => _rawPane(),
    };
  }

  Widget _rawPane() {
    return Column(
      children: [
        Expanded(child: _entryList()),
        _composer(),
      ],
    );
  }

  Widget _entryList() {
    final children = <Widget>[];
    if (_hasMore) {
      children.add(TextButton(onPressed: _loadOlder, child: const Text('更早')));
    }
    String? day;
    for (final entry in _entries) {
      final label = _dayLabel(entry.at);
      if (label != day) {
        day = label;
        children.add(
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Center(child: Text(label)),
          ),
        );
      }
      final mine = entry.speaker == 'me';
      children.add(
        Align(
          alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
          child: GestureDetector(
            onTap: () => _editEntry(entry),
            onLongPress: () {
              setState(() {
                _selectedText = entry.text;
                _selectedPath =
                    'inputs/people/${widget.personId}/entries.jsonl';
              });
              _publish();
            },
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
              padding: const EdgeInsets.all(10),
              constraints: const BoxConstraints(maxWidth: 420),
              decoration: BoxDecoration(
                color: mine
                    ? Theme.of(context).colorScheme.primaryContainer
                    : Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    entry.kind == 'note'
                        ? '自述'
                        : mine
                        ? '自己'
                        : _name,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  Text(entry.text),
                  Align(
                    alignment: Alignment.centerRight,
                    child: IconButton(
                      onPressed: () => _deleteEntry(entry),
                      icon: const Icon(Icons.delete_outline, size: 16),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    return ListView(children: children);
  }

  Widget _micButton() {
    final color = Theme.of(context).colorScheme.primary;
    return IconButton(
      onPressed: _listen,
      icon: SizedBox(
        width: 24,
        height: 24,
        child: Stack(
          alignment: Alignment.center,
          clipBehavior: Clip.none,
          children: [
            if (_listening)
              AnimatedBuilder(
                animation: Listenable.merge([_pulse, _soundLevel]),
                builder: (context, _) {
                  final wave = Curves.easeInOut.transform(_pulse.value);
                  final loud = speechLevel(_soundLevel.value);
                  final size = 22 + wave * 8 + loud * 10;
                  return Container(
                    width: size,
                    height: size,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color.withValues(alpha: 0.16 + loud * 0.28),
                    ),
                  );
                },
              ),
            Icon(
              _listening ? Icons.mic : Icons.mic_none,
              color: _listening ? color : null,
            ),
          ],
        ),
      ),
    );
  }

  Widget _composer() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        child: Column(
          children: [
            Row(
              children: [
                if (!_draft.note)
                  Row(
                    children: [
                      const Text('自己'),
                      Switch(
                        value: _draft.mine,
                        onChanged: (value) =>
                            setState(() => _draft.mine = value),
                      ),
                    ],
                  ),
                TextButton(
                  onPressed: () => setState(() => _draft.note = !_draft.note),
                  child: Text(_draft.note ? '自述中' : '自述'),
                ),
                _micButton(),
                IconButton(
                  onPressed: _pickImages,
                  icon: const Icon(Icons.photo_outlined),
                ),
              ],
            ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    focusNode: _inputFocus,
                    scrollController: _inputScroll,
                    minLines: 1,
                    maxLines: 5,
                  ),
                ),
                IconButton(
                  onPressed: _saving ? null : _send,
                  icon: const Icon(Icons.send),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _digestPane() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (_canOrganize) const Text('还有原文没写入历史简报'),
        if (widget.embedded)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => setState(() {
                _pane = PersonPane.raw;
                _publish();
              }),
              child: const Text('原文'),
            ),
          ),
        SelectionArea(
          onSelectionChanged: (content) {
            final text = content?.plainText.trim();
            if (text == null || text.isEmpty) return;
            _selectedText = text;
            _selectedPath = 'inputs/people/${widget.personId}/digest.md';
            _publish();
          },
          child: MarkdownBody(data: _digest.isEmpty ? '还没有历史简报' : _digest),
        ),
      ],
    );
  }

  Widget _profilePane() {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          Expanded(
            child: TextField(
              controller: _profileEditor,
              maxLines: null,
              expands: true,
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              onPressed: () => _saveProfile(_profileEditor.text),
              child: const Text('保存'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _consultPane() {
    final sessionId = widget.controller.machine.currentSessionId;
    if (sessionId == null) return const Center(child: Text('还没有咨询'));
    return ChatPage(
      controller: widget.controller,
      sessionId: sessionId,
      embedded: true,
      consult: _currentConsult(),
      onOrganizeSent: () => _organizePending = true,
    );
  }

  String _dayLabel(String at) {
    final time = DateTime.tryParse(at)?.toLocal();
    if (time == null) return '录入';
    final month = time.month.toString().padLeft(2, '0');
    final day = time.day.toString().padLeft(2, '0');
    return '录入 ${time.year}-$month-$day';
  }
}

class _TextDialog extends StatefulWidget {
  const _TextDialog({
    required this.title,
    required this.initial,
    required this.action,
  });

  final String title;
  final String initial;
  final String action;

  @override
  State<_TextDialog> createState() => _TextDialogState();
}

class _TextDialogState extends State<_TextDialog> {
  late final TextEditingController _text = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(controller: _text, autofocus: true),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _text.text),
          child: Text(widget.action),
        ),
      ],
    );
  }
}

class _EntryEdit {
  const _EntryEdit({required this.text, required this.speaker});

  final String text;
  final String speaker;
}

class _EntryEditDialog extends StatefulWidget {
  const _EntryEditDialog({required this.entry});

  final _RawEntry entry;

  @override
  State<_EntryEditDialog> createState() => _EntryEditDialogState();
}

class _EntryEditDialogState extends State<_EntryEditDialog> {
  late final TextEditingController _text = TextEditingController(
    text: widget.entry.text,
  );
  late var _speaker = widget.entry.speaker ?? 'them';

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('修改'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(controller: _text, maxLines: 4),
          if (widget.entry.kind == 'line')
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('自己'),
              value: _speaker == 'me',
              onChanged: (value) =>
                  setState(() => _speaker = value ? 'me' : 'them'),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(
            context,
            _EntryEdit(text: _text.text, speaker: _speaker),
          ),
          child: const Text('保存'),
        ),
      ],
    );
  }
}
