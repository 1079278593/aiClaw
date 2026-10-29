import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import 'chat_page.dart';

class ReflectionPage extends StatefulWidget {
  const ReflectionPage({
    super.key,
    required this.controller,
    this.path,
    this.folder = 'inbox',
  });

  final AppController controller;
  final String? path;
  final String folder;

  @override
  State<ReflectionPage> createState() => _ReflectionPageState();
}

class _ReflectionMediaItem {
  const _ReflectionMediaItem({
    required this.kind,
    required this.src,
    this.id = '',
    this.transcript = '',
    this.alt = '',
  });

  final String kind; // audio | image
  final String id;
  final String src;
  final String transcript;
  final String alt;
}

class _ReflectionPageState extends State<ReflectionPage> {
  final _title = TextEditingController();
  final _body = TextEditingController();
  final _bodyFocus = FocusNode();
  final _recorder = AudioRecorder();
  final _speech = SpeechToText();
  final _player = AudioPlayer();
  final _picker = ImagePicker();

  String _path = '';
  String? _error;
  var _loading = false;
  var _dirty = false;
  var _saving = false;
  var _saveFailed = false;
  var _recording = false;
  var _uploadingMedia = false;
  var _speechReady = false;
  String _speechDraft = '';
  String? _playingSrc;
  Timer? _debounce;
  static const _autosaveDelay = Duration(milliseconds: 1000);
  static final _audioBlockRe = RegExp(
    r'^:::aiclaw-audio\[([^\]]*)\]\r?\n([\s\S]*?)^:::\s*$',
    multiLine: true,
  );
  static final _imageMdRe = RegExp(r'!\[([^\]]*)\]\(([^)\s]+)\)');

  @override
  void initState() {
    super.initState();
    _path = widget.path ?? '';
    _title.addListener(_onEdited);
    _body.addListener(_onEdited);
    if (_path.isNotEmpty) {
      _load();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _title.removeListener(_onEdited);
    _body.removeListener(_onEdited);
    unawaited(_recorder.dispose());
    unawaited(_player.dispose());
    if (_speech.isListening) unawaited(_speech.cancel());
    _title.dispose();
    _body.dispose();
    _bodyFocus.dispose();
    super.dispose();
  }

  void _onEdited() {
    if (_loading) return;
    _dirty = true;
    _saveFailed = false;
    if (mounted) setState(() {});
    _debounce?.cancel();
    _debounce = Timer(_autosaveDelay, () {
      unawaited(_save(quiet: true));
    });
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final payload = await widget.controller.api.getJson(
        apiUri(widget.controller.baseUrl, '/api/reflections/content', {
          'path': _path,
        }),
        token: widget.controller.token,
      );
      final reflection = payload['reflection'];
      if (reflection is! Map) throw ApiException(500, '无效响应');
      final map = Map<String, Object?>.from(reflection);
      if (!mounted) return;
      _title.removeListener(_onEdited);
      _body.removeListener(_onEdited);
      setState(() {
        _path = '${map['path'] ?? _path}';
        _title.text = '${map['title'] ?? ''}';
        _body.text = '${map['body'] ?? ''}';
        _loading = false;
        _dirty = false;
        _saveFailed = false;
      });
      _title.addListener(_onEdited);
      _body.addListener(_onEdited);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  Future<bool> _flush() async {
    _debounce?.cancel();
    _debounce = null;
    if (!_dirty && !_saving) return true;
    return _save(quiet: true);
  }

  Future<bool> _save({required bool quiet}) async {
    final rawTitle = _title.text.trim();
    final body = _body.text;
    final title = rawTitle.isNotEmpty
        ? rawTitle
        : (body.trim().isNotEmpty ? '未命名心得' : '');
    if (title.isEmpty && body.trim().isEmpty) {
      _dirty = false;
      if (mounted) setState(() {});
      return true;
    }
    if (_saving) {
      while (_saving) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      if (!_dirty) return !_saveFailed;
    }
    if (!mounted) return false;
    setState(() {
      _saving = true;
      _saveFailed = false;
    });
    try {
      final creating = _path.isEmpty;
      final payload = await widget.controller.api.sendJson(
        creating ? 'POST' : 'PUT',
        apiUri(
          widget.controller.baseUrl,
          creating ? '/api/reflections' : '/api/reflections/content',
        ),
        token: widget.controller.token,
        body: {
          if (!creating) 'path': _path,
          'title': title,
          'body': body,
          if (creating)
            'folder': widget.folder.isEmpty ? 'inbox' : widget.folder,
        },
      );
      final reflection = payload['reflection'];
      if (reflection is Map) {
        _path = '${reflection['path'] ?? _path}';
        final savedTitle = '${reflection['title'] ?? title}';
        if (_title.text.trim().isEmpty && savedTitle.isNotEmpty) {
          _title.removeListener(_onEdited);
          _title.text = savedTitle;
          _title.addListener(_onEdited);
        }
      }
      _dirty = false;
      if (!mounted) return true;
      setState(() {});
      return true;
    } on ApiException catch (error) {
      _saveFailed = true;
      if (!mounted) return false;
      setState(() {});
      if (!quiet) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<String?> _ensurePath() async {
    await _flush();
    if (_path.isNotEmpty) return _path;
    if (_title.text.trim().isEmpty) {
      _title.removeListener(_onEdited);
      _title.text = '未命名心得';
      _title.addListener(_onEdited);
    }
    _dirty = true;
    final ok = await _save(quiet: false);
    if (!ok || _path.isEmpty) return null;
    return _path;
  }

  void _insertAtCaret(String text) {
    final value = _body.value;
    final selection = value.selection;
    final start = selection.isValid ? selection.start : value.text.length;
    final end = selection.isValid ? selection.end : start;
    final before = value.text.substring(0, start);
    final after = value.text.substring(end);
    var prefix = '';
    if (before.isNotEmpty && !before.endsWith('\n\n')) {
      prefix = before.endsWith('\n') ? '\n' : '\n\n';
    }
    final suffix = after.startsWith('\n') ? '' : '\n\n';
    final inserted = '$prefix$text$suffix';
    final next = '$before$inserted$after';
    final cursor = before.length + inserted.length;
    _body.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: cursor),
    );
    _bodyFocus.requestFocus();
  }

  List<_ReflectionMediaItem> _parseMedia(String body) {
    final items = <_ReflectionMediaItem>[];
    for (final match in _audioBlockRe.allMatches(body)) {
      final attrs = _parseAttrs(match.group(1) ?? '');
      items.add(_ReflectionMediaItem(
        kind: 'audio',
        id: attrs['id'] ?? '',
        src: attrs['src'] ?? '',
        transcript: (match.group(2) ?? '').trim(),
      ));
    }
    for (final match in _imageMdRe.allMatches(body)) {
      final src = match.group(2) ?? '';
      if (!src.contains('.assets/')) continue;
      items.add(_ReflectionMediaItem(
        kind: 'image',
        src: src,
        alt: match.group(1) ?? '',
      ));
    }
    return items;
  }

  Map<String, String> _parseAttrs(String raw) {
    final out = <String, String>{};
    final parts = RegExp(r'(?:[^\s"]+|"[^"]*")+').allMatches(raw);
    for (final part in parts) {
      final token = part.group(0) ?? '';
      final eq = token.indexOf('=');
      if (eq <= 0) continue;
      var value = token.substring(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.substring(1, value.length - 1);
      }
      out[token.substring(0, eq).trim()] = value;
    }
    return out;
  }

  String _resolveMediaPath(String src) {
    final normalized = src.replaceAll('\\', '/').trim();
    if (normalized.isEmpty || _path.isEmpty) return '';
    if (normalized.startsWith('inputs/reflections/')) return normalized;
    final slash = _path.lastIndexOf('/');
    final dir = slash == -1 ? '' : _path.substring(0, slash + 1);
    if (normalized.startsWith('./')) return '$dir${normalized.substring(2)}';
    return '$dir$normalized';
  }

  Future<void> _pickImage() async {
    final file = await _picker.pickImage(source: ImageSource.gallery);
    if (file == null) return;
    final notePath = await _ensurePath();
    if (notePath == null) return;
    setState(() => _uploadingMedia = true);
    try {
      final bytes = await file.readAsBytes();
      final payload = await widget.controller.api.postMultipart(
        apiUri(widget.controller.baseUrl, '/api/reflections/media'),
        token: widget.controller.token,
        fields: {'path': notePath, 'kind': 'image'},
        files: [
          (
            filename: file.name.isEmpty ? 'image.jpg' : file.name,
            bytes: bytes,
            mime: 'image/jpeg',
          ),
        ],
        fileField: 'file',
      );
      final marker = '${payload['marker'] ?? ''}';
      if (marker.isEmpty) throw ApiException(500, '上传失败');
      _insertAtCaret(marker);
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      if (mounted) setState(() => _uploadingMedia = false);
    }
  }

  Future<void> _toggleRecord() async {
    if (_recording) {
      await _stopRecord();
      return;
    }
    final notePath = await _ensurePath();
    if (notePath == null) return;
    final hasMic = await _recorder.hasPermission();
    if (!hasMic) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('需要麦克风权限')));
      return;
    }
    if (!_speechReady) {
      _speechReady = await _speech.initialize(
        onError: (_) {},
        onStatus: (_) {},
      );
    }
    final dir = await getTemporaryDirectory();
    final filePath =
        '${dir.path}/reflection_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        bitRate: 64000,
        numChannels: 1,
      ),
      path: filePath,
    );
    _speechDraft = '';
    if (_speechReady) {
      await _speech.listen(
        listenOptions: SpeechListenOptions(
          localeId: 'zh_CN',
          listenMode: ListenMode.dictation,
          partialResults: true,
          cancelOnError: true,
        ),
        onResult: (SpeechRecognitionResult result) {
          _speechDraft = result.recognizedWords;
          if (mounted) setState(() {});
        },
      );
    }
    if (!mounted) return;
    setState(() => _recording = true);
  }

  Future<void> _stopRecord() async {
    final recordedPath = await _recorder.stop();
    if (_speech.isListening) await _speech.stop();
    final transcript = _speechDraft.trim();
    if (!mounted) return;
    setState(() => _recording = false);
    if (recordedPath == null || recordedPath.isEmpty) return;
    final notePath = await _ensurePath();
    if (notePath == null) return;
    setState(() => _uploadingMedia = true);
    try {
      final bytes = await File(recordedPath).readAsBytes();
      final payload = await widget.controller.api.postMultipart(
        apiUri(widget.controller.baseUrl, '/api/reflections/media'),
        token: widget.controller.token,
        fields: {
          'path': notePath,
          'kind': 'audio',
          if (transcript.isNotEmpty) 'transcript': transcript,
        },
        files: [
          (
            filename: 'voice.m4a',
            bytes: Uint8List.fromList(bytes),
            mime: 'audio/mp4',
          ),
        ],
        fileField: 'file',
      );
      final marker = '${payload['marker'] ?? ''}';
      if (marker.isEmpty) throw ApiException(500, '上传失败');
      _insertAtCaret(marker);
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    } finally {
      try {
        await File(recordedPath).delete();
      } catch (_) {}
      if (mounted) setState(() => _uploadingMedia = false);
    }
  }

  Future<void> _togglePlay(_ReflectionMediaItem item) async {
    final mediaPath = _resolveMediaPath(item.src);
    if (mediaPath.isEmpty) return;
    if (_playingSrc == item.src && _player.playing) {
      await _player.pause();
      if (mounted) setState(() {});
      return;
    }
    try {
      final bytes = await widget.controller.api.getBytes(
        apiUri(widget.controller.baseUrl, '/api/reflections/media', {
          'path': mediaPath,
        }),
        token: widget.controller.token,
      );
      final dir = await getTemporaryDirectory();
      final file = File(
        '${dir.path}/play_${DateTime.now().millisecondsSinceEpoch}.m4a',
      );
      await file.writeAsBytes(bytes, flush: true);
      await _player.setFilePath(file.path);
      _playingSrc = item.src;
      await _player.play();
      if (mounted) setState(() {});
      _player.playerStateStream.listen((state) {
        if (state.processingState == ProcessingState.completed) {
          _playingSrc = null;
          if (mounted) setState(() {});
        }
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _ask() async {
    final ok = await _flush();
    if (!ok || _path.isEmpty) {
      if (mounted && _path.isEmpty) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('请先写下内容')));
      }
      return;
    }
    try {
      final opened = await widget.controller.openDocumentAt(_path);
      if (!opened) {
        if (!mounted) return;
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('无法附带该心得')));
        return;
      }
      await widget.controller.setAttachDocument(true);
      var sessionId = widget.controller.machine.currentSessionId;
      if (sessionId == null || sessionId.isEmpty) {
        final created = await widget.controller.createSession();
        if (created.id.isEmpty) return;
        widget.controller.openSession(created.id);
        sessionId = created.id;
      }
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ChatPage(controller: widget.controller, sessionId: sessionId!),
        ),
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  String get _statusText {
    if (_recording) return '录音中…';
    if (_uploadingMedia) return '上传中…';
    if (_saving) return '保存中…';
    if (_saveFailed) return '保存失败';
    if (_dirty) return '未保存';
    if (_path.isNotEmpty) return '已保存';
    return '';
  }

  @override
  Widget build(BuildContext context) {
    final titleStyle = Theme.of(context).textTheme.headlineSmall;
    final bodyStyle = Theme.of(context).textTheme.bodyMedium;
    final mediaItems = _parseMedia(_body.text);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;
        if (_recording) await _stopRecord();
        final ok = await _flush();
        if (!mounted) return;
        final leave = ok ? true : await _confirmLeave();
        if (!mounted || !leave) return;
        Navigator.of(this.context).pop(result);
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_title.text.trim().isEmpty ? '心得' : _title.text.trim()),
          actions: [
            if (_statusText.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Center(
                  child: Text(
                    _statusText,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.outline,
                        ),
                  ),
                ),
              ),
            IconButton(
              onPressed: _uploadingMedia ? null : _pickImage,
              tooltip: '插入图片',
              icon: const Icon(Icons.image_outlined),
            ),
            IconButton(
              onPressed: _uploadingMedia ? null : _toggleRecord,
              tooltip: _recording ? '结束录音' : '录音',
              icon: Icon(_recording ? Icons.stop_circle_outlined : Icons.mic_none),
              color: _recording ? Theme.of(context).colorScheme.error : null,
            ),
            IconButton(
              onPressed: _ask,
              tooltip: '拿去问',
              icon: const Icon(Icons.chat_bubble_outline),
            ),
          ],
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text(_error!))
                : ListView(
                    padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                    children: [
                      TextField(
                        controller: _title,
                        style: titleStyle,
                        decoration: const InputDecoration(
                          hintText: '标题',
                          border: InputBorder.none,
                        ),
                        textInputAction: TextInputAction.next,
                        onSubmitted: (_) => _bodyFocus.requestFocus(),
                        onChanged: (_) => setState(() {}),
                      ),
                      TextField(
                        controller: _body,
                        focusNode: _bodyFocus,
                        style: bodyStyle,
                        decoration: const InputDecoration(
                          hintText: '正文',
                          border: InputBorder.none,
                        ),
                        keyboardType: TextInputType.multiline,
                        maxLines: null,
                        minLines: 12,
                      ),
                      if (_recording && _speechDraft.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            '转写草稿：$_speechDraft',
                            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                  color: Theme.of(context).colorScheme.outline,
                                ),
                          ),
                        ),
                      if (mediaItems.isNotEmpty) ...[
                        const SizedBox(height: 16),
                        Text(
                          '文内附件',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        const SizedBox(height: 8),
                        ...mediaItems.map((item) => _buildMediaTile(item)),
                      ],
                    ],
                  ),
      ),
    );
  }

  Widget _buildMediaTile(_ReflectionMediaItem item) {
    if (item.kind == 'image') {
      final mediaPath = _resolveMediaPath(item.src);
      return Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: mediaPath.isEmpty
              ? Text(item.alt.isEmpty ? '图片' : item.alt)
              : FutureBuilder<Uint8List>(
                  future: widget.controller.api.getBytes(
                    apiUri(
                      widget.controller.baseUrl,
                      '/api/reflections/media',
                      {'path': mediaPath},
                    ),
                    token: widget.controller.token,
                  ),
                  builder: (context, snapshot) {
                    if (!snapshot.hasData) {
                      return const SizedBox(
                        height: 80,
                        child: Center(child: CircularProgressIndicator()),
                      );
                    }
                    return Image.memory(
                      snapshot.data!,
                      height: 160,
                      fit: BoxFit.contain,
                    );
                  },
                ),
        ),
      );
    }
    final playing = _playingSrc == item.src && _player.playing;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: IconButton(
          onPressed: () => unawaited(_togglePlay(item)),
          icon: Icon(playing ? Icons.pause_circle_outline : Icons.play_circle_outline),
        ),
        title: Text(item.transcript.isEmpty ? '语音' : item.transcript),
        subtitle: const Text('原声保留'),
        trailing: IconButton(
          tooltip: '改转写草稿',
          onPressed: () => unawaited(_editTranscript(item)),
          icon: const Icon(Icons.edit_note_outlined),
        ),
      ),
    );
  }

  Future<void> _editTranscript(_ReflectionMediaItem item) async {
    final controller = TextEditingController(text: item.transcript);
    final next = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('改转写草稿'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '系统 Speech 无法对已存录音自动重转。可手改草稿，或再录一条。云端精转见后续。',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              maxLines: 4,
              decoration: const InputDecoration(
                hintText: '转写草稿',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, controller.text),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (next == null || !mounted) return;
    final body = _body.text;
    RegExpMatch? match;
    for (final candidate in _audioBlockRe.allMatches(body)) {
      final attrs = _parseAttrs(candidate.group(1) ?? '');
      final hit = item.id.isNotEmpty
          ? attrs['id'] == item.id
          : attrs['src'] == item.src;
      if (hit) {
        match = candidate;
        break;
      }
    }
    if (match == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('找不到对应语音块')),
      );
      return;
    }
    final attrs = _parseAttrs(match.group(1) ?? '');
    final replacement =
        ':::aiclaw-audio[id=${attrs['id'] ?? item.id} src="${attrs['src'] ?? item.src}"]\n${next.trim()}\n:::';
    _body.value = TextEditingValue(
      text: body.replaceRange(match.start, match.end, replacement),
    );
  }

  Future<bool> _confirmLeave() async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('尚未保存'),
        content: const Text('自动保存尚未完成或失败，离开可能丢失修改。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('留下'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('仍要离开'),
          ),
        ],
      ),
    );
    return result == true;
  }
}
