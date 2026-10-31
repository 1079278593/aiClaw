import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audio_session/audio_session.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../src/api_client.dart';
import '../src/app_controller.dart';
import '../src/reflection_body.dart';
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
  String? _transportSrc;
  String? _loadedSrc;
  StreamSubscription<PlayerState>? _playerSub;
  Timer? _debounce;
  List<ReflectionPiece> _pieces = [ReflectionPiece.text('')];
  List<TextEditingController> _pieceControllers = [];
  int _pieceKey = 0;
  final Map<String, String> _localAudio = {};
  final Map<String, Duration> _audioDuration = {};
  static const _autosaveDelay = Duration(milliseconds: 1000);
  static final _audioBlockRe = RegExp(
    r'^:::aiclaw-audio\[([^\]]*)\]\r?\n([\s\S]*?)^:::[ \t]*$',
    multiLine: true,
  );

  @override
  void initState() {
    super.initState();
    _path = widget.path ?? '';
    _title.addListener(_onEdited);
    _body.addListener(_onEdited);
    _playerSub = _player.playerStateStream.listen((_) {
      if (mounted) setState(() {});
    });
    _reloadPieces();
    if (_path.isNotEmpty) {
      _load();
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _playerSub?.cancel();
    _title.removeListener(_onEdited);
    _body.removeListener(_onEdited);
    for (final controller in _pieceControllers) {
      controller.dispose();
    }
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
      _reloadPieces();
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
    _body.removeListener(_onEdited);
    _body.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: cursor),
    );
    _body.addListener(_onEdited);
    _reloadPieces();
    _onEdited();
  }

  void _reloadPieces() {
    final next = splitReflectionBody(_body.text);
    final key = Object.hashAll(next.map((piece) => piece.kind == 'text' ? 'text' : piece.raw));
    _pieces = next;
    if (key == _pieceKey && _pieceControllers.length == next.where((piece) => piece.kind == 'text').length) {
      return;
    }
    final retired = _pieceControllers;
    _pieceKey = key;
    _pieceControllers = [];
    for (final piece in next.where((piece) => piece.kind == 'text')) {
      final controller = TextEditingController(text: piece.text);
      controller.addListener(() => _onPieceText(controller));
      _pieceControllers.add(controller);
    }
    for (final piece in next.where((piece) => piece.kind == 'audio')) {
      unawaited(_ensureDuration(piece));
    }
    if (retired.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final controller in retired) {
        if (!_pieceControllers.contains(controller)) controller.dispose();
      }
    });
  }

  void _onPieceText(TextEditingController controller) {
    if (!_pieceControllers.contains(controller)) return;
    var textIndex = 0;
    final next = <ReflectionPiece>[];
    for (final piece in _pieces) {
      if (piece.kind != 'text') {
        next.add(piece);
        continue;
      }
      final current = textIndex < _pieceControllers.length ? _pieceControllers[textIndex] : null;
      textIndex += 1;
      next.add(identical(current, controller) ? piece.withText(controller.text) : piece);
    }
    _pieces = next;
    final composed = composeReflectionBody(next);
    if (_body.text == composed) return;
    _body.removeListener(_onEdited);
    _body.text = composed;
    _body.addListener(_onEdited);
    _onEdited();
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

  Future<void> _usePlaybackSession() async {
    final session = await AudioSession.instance;
    // defaultToSpeaker 只能配 playAndRecord。配在 playback 上会得到 OSStatus -50。
    await session.configure(const AudioSessionConfiguration(
      avAudioSessionCategory: AVAudioSessionCategory.playback,
      avAudioSessionMode: AVAudioSessionMode.spokenAudio,
    ));
    await session.setActive(true);
  }

  Future<String?> _ensureAudioFile(ReflectionPiece item) async {
    final cached = _localAudio[item.src];
    if (cached != null && File(cached).existsSync()) return cached;
    final mediaPath = _resolveMediaPath(item.src);
    if (mediaPath.isEmpty) return null;
    final bytes = await widget.controller.api.getBytes(
      apiUri(widget.controller.baseUrl, '/api/reflections/media', {'path': mediaPath}),
      token: widget.controller.token,
    );
    if (bytes.length < 32) throw ApiException(500, '录音文件是空的');
    final dir = await getTemporaryDirectory();
    final safeId = item.id.isEmpty ? '${item.src.hashCode}' : item.id;
    final file = File('${dir.path}/reflection_$safeId.m4a');
    await file.writeAsBytes(bytes, flush: true);
    _localAudio[item.src] = file.path;
    return file.path;
  }

  Future<void> _ensureDuration(ReflectionPiece item) async {
    if (_audioDuration.containsKey(item.src)) return;
    try {
      final path = await _ensureAudioFile(item);
      if (path == null) return;
      final probe = AudioPlayer();
      try {
        await probe.setFilePath(path);
        final duration = probe.duration;
        if (duration != null) _audioDuration[item.src] = duration;
      } finally {
        await probe.dispose();
      }
      if (mounted) setState(() {});
    } catch (_) {}
  }

  Future<void> _loadSource(ReflectionPiece item, String path) async {
    if (_loadedSrc == item.src && _player.duration != null) return;
    await _player.setFilePath(path);
    _loadedSrc = item.src;
    final duration = _player.duration;
    if (duration != null) _audioDuration[item.src] = duration;
  }

  Future<void> _togglePlay(ReflectionPiece item) async {
    _transportSrc = item.src;
    if (_loadedSrc == item.src && _player.playing) {
      await _player.pause();
      if (mounted) setState(() {});
      return;
    }
    try {
      await _usePlaybackSession();
      final path = await _ensureAudioFile(item);
      if (path == null) throw ApiException(404, '找不到录音');
      await _loadSource(item, path);
      await _player.play();
      if (mounted) setState(() {});
    } catch (error) {
      if (!mounted) return;
      final message = error is ApiException ? error.message : '无法播放：$error';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  Future<void> _seekBy(ReflectionPiece item, int seconds) async {
    _transportSrc = item.src;
    try {
      await _usePlaybackSession();
      final path = await _ensureAudioFile(item);
      if (path == null) throw ApiException(404, '找不到录音');
      await _loadSource(item, path);
      final duration = _player.duration ?? _audioDuration[item.src] ?? Duration.zero;
      var next = _player.position + Duration(seconds: seconds);
      if (next < Duration.zero) next = Duration.zero;
      if (duration > Duration.zero && next > duration) next = duration;
      await _player.seek(next);
      if (!_player.playing) await _player.play();
      if (mounted) setState(() {});
    } catch (error) {
      if (!mounted) return;
      final message = error is ApiException ? error.message : '无法播放：$error';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
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
                      ..._bodyPieces(bodyStyle),
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
                    ],
                  ),
      ),
    );
  }

  List<Widget> _bodyPieces(TextStyle? bodyStyle) {
    var textIndex = 0;
    final children = <Widget>[];
    for (final piece in _pieces) {
      if (piece.kind == 'text') {
        if (textIndex >= _pieceControllers.length) break;
        final controller = _pieceControllers[textIndex];
        textIndex += 1;
        children.add(TextField(
          controller: controller,
          focusNode: textIndex == 1 ? _bodyFocus : null,
          style: bodyStyle,
          decoration: InputDecoration(
            hintText: textIndex == 1 ? '正文' : null,
            border: InputBorder.none,
            isCollapsed: textIndex != 1,
          ),
          keyboardType: TextInputType.multiline,
          maxLines: null,
          minLines: textIndex == 1 && _pieces.length == 1 ? 12 : 1,
        ));
      } else if (piece.kind == 'audio') {
        children.add(_audioCard(piece));
      } else if (piece.kind == 'image') {
        children.add(_imageBlock(piece));
      }
    }
    return children;
  }

  Widget _audioCard(ReflectionPiece item) {
    final scheme = Theme.of(context).colorScheme;
    final playing = _loadedSrc == item.src && _player.playing;
    final showTransport = _transportSrc == item.src;
    final when = audioRecordedLabel(item.id);
    final length = formatAudioLength(_audioDuration[item.src]);
    final excerpt = item.transcript.isEmpty ? '无' : item.transcript;
    final small = Theme.of(context).textTheme.bodySmall;
    return GestureDetector(
      onLongPress: () => unawaited(_showAudioMenu(item)),
      child: Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 8),
        padding: const EdgeInsets.fromLTRB(14, 10, 6, 12),
        decoration: BoxDecoration(
          color: scheme.brightness == Brightness.dark ? const Color(0xFF2C2C2C) : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: scheme.onSurface.withValues(alpha: 0.28)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        item.audioTitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context)
                            .textTheme
                            .titleMedium
                            ?.copyWith(fontWeight: FontWeight.w600),
                      ),
                      if (when.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(when, style: small),
                        ),
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(length, style: small),
                      ),
                    ],
                  ),
                ),
                if (!showTransport)
                  IconButton(
                    tooltip: '播放',
                    onPressed: () => unawaited(_togglePlay(item)),
                    icon: const Icon(Icons.play_arrow_rounded, size: 32),
                  )
                else
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _seekButton(item, -15, Icons.replay_rounded),
                      IconButton(
                        tooltip: playing ? '暂停' : '播放',
                        onPressed: () => unawaited(_togglePlay(item)),
                        icon: Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded, size: 32),
                      ),
                      _seekButton(item, 15, Icons.forward_rounded),
                    ],
                  ),
              ],
            ),
            Divider(height: 16, color: scheme.onSurface.withValues(alpha: 0.2)),
            Text('听写文本', style: Theme.of(context).textTheme.labelLarge),
            const SizedBox(height: 2),
            Text(
              excerpt,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }

  Widget _seekButton(ReflectionPiece item, int seconds, IconData icon) {
    final label = seconds.abs().toString();
    return IconButton(
      tooltip: seconds < 0 ? '倒退 $label 秒' : '前进 $label 秒',
      onPressed: () => unawaited(_seekBy(item, seconds)),
      icon: SizedBox(
        width: 32,
        height: 32,
        child: Stack(
          alignment: Alignment.center,
          children: [
            Icon(icon, size: 28),
            Text(label, style: const TextStyle(fontSize: 9, fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }

  Widget _imageBlock(ReflectionPiece item) {
    final mediaPath = _resolveMediaPath(item.src);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: mediaPath.isEmpty
          ? Text(item.alt.isEmpty ? '图片' : item.alt)
          : FutureBuilder<Uint8List>(
              future: widget.controller.api.getBytes(
                apiUri(widget.controller.baseUrl, '/api/reflections/media', {'path': mediaPath}),
                token: widget.controller.token,
              ),
              builder: (context, snapshot) {
                if (snapshot.hasError) return const Text('图片无法加载');
                if (!snapshot.hasData) {
                  return const SizedBox(
                    height: 80,
                    child: Center(child: CircularProgressIndicator()),
                  );
                }
                return ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image.memory(snapshot.data!, fit: BoxFit.contain),
                );
              },
            ),
    );
  }

  /// 改一条语音标记的转写或名称；标记原文变了，界面片段一起重画。
  bool _rewriteAudioMarker(ReflectionPiece item, {String? name, String? transcript}) {
    final body = _body.text;
    RegExpMatch? match;
    for (final candidate in _audioBlockRe.allMatches(body)) {
      final attrs = parseReflectionAttrs(candidate.group(1) ?? '');
      final hit = item.id.isNotEmpty ? attrs['id'] == item.id : attrs['src'] == item.src;
      if (hit) {
        match = candidate;
        break;
      }
    }
    if (match == null) return false;
    final attrs = parseReflectionAttrs(match.group(1) ?? '');
    final replacement = formatAudioBlock(
      id: attrs['id'] ?? item.id,
      src: attrs['src'] ?? item.src,
      name: name ?? attrs['name'] ?? item.name,
      transcript: transcript ?? (match.group(2) ?? '').trim(),
    );
    _body.removeListener(_onEdited);
    _body.value = TextEditingValue(
      text: body.replaceRange(match.start, match.end, replacement),
    );
    _body.addListener(_onEdited);
    _reloadPieces();
    _onEdited();
    return true;
  }

  Future<void> _showAudioMenu(ReflectionPiece item) async {
    final scheme = Theme.of(context).colorScheme;
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.drive_file_rename_outline),
              title: const Text('重命名'),
              onTap: () => Navigator.pop(context, 'rename'),
            ),
            ListTile(
              leading: const Icon(Icons.text_fields),
              title: const Text('编辑听写文本'),
              onTap: () => Navigator.pop(context, 'transcript'),
            ),
            ListTile(
              leading: Icon(Icons.delete_outline, color: scheme.error),
              title: Text('删除', style: TextStyle(color: scheme.error)),
              onTap: () => Navigator.pop(context, 'delete'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || action == null) return;
    if (action == 'rename') await _renameAudio(item);
    if (action == 'transcript') await _editTranscript(item);
    if (action == 'delete') await _deleteAudio(item);
  }

  Future<void> _renameAudio(ReflectionPiece item) async {
    final controller = TextEditingController(text: item.name);
    final next = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('录音名称'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: '录音',
            border: OutlineInputBorder(),
          ),
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
    if (!_rewriteAudioMarker(item, name: next.trim())) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('找不到对应语音块')),
      );
    }
  }

  Future<void> _deleteAudio(ReflectionPiece item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除录音'),
        content: const Text('录音和听写文本都会删掉，原声文件一起删除。'),
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
    if (ok != true || !mounted) return;
    final body = _body.text;
    RegExpMatch? match;
    for (final candidate in _audioBlockRe.allMatches(body)) {
      final attrs = parseReflectionAttrs(candidate.group(1) ?? '');
      final hit = item.id.isNotEmpty ? attrs['id'] == item.id : attrs['src'] == item.src;
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
    _body.removeListener(_onEdited);
    _body.value = TextEditingValue(
      text: body.replaceRange(match.start, match.end, ''),
    );
    _body.addListener(_onEdited);
    if (_loadedSrc == item.src) {
      await _player.stop();
      _loadedSrc = null;
      _transportSrc = null;
    }
    _localAudio.remove(item.src);
    _audioDuration.remove(item.src);
    _reloadPieces();
    _onEdited();
    await _flush();
    final mediaPath = _resolveMediaPath(item.src);
    if (mediaPath.isEmpty) return;
    try {
      await widget.controller.api.sendJson(
        'DELETE',
        apiUri(widget.controller.baseUrl, '/api/reflections/media', {'path': mediaPath}),
        token: widget.controller.token,
      );
    } on ApiException catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  Future<void> _editTranscript(ReflectionPiece item) async {
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
    if (!_rewriteAudioMarker(item, transcript: next.trim())) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('找不到对应语音块')),
      );
    }
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
