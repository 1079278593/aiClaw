import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';
import 'chat_models.dart';
import 'live_socket.dart';
import 'session_machine.dart';

class SessionSummary {
  SessionSummary({required this.id, required this.title, required this.updatedAt});
  final String id;
  final String title;
  final String updatedAt;
}

class AppController extends ChangeNotifier with WidgetsBindingObserver {
  AppController({FlutterSecureStorage? storage, ApiClient? api})
      : storage = storage ?? const FlutterSecureStorage(),
        api = api ?? ApiClient() {
    socket = LiveSocket(
      onMessage: machine.onServerMessage,
      onAuthRejected: _onAuthRejected,
      onStatus: (connected) {
        socketConnected = connected;
        if (connected && writeEnabled) machine.setWritePermission(true);
        if (connected && machine.currentSessionId != null) {
          machine.selectSession(machine.currentSessionId!);
        }
        notifyListeners();
      },
    );
    machine.onChanged = notifyListeners;
    machine.onSend = socket.send;
  }

  final FlutterSecureStorage storage;
  final ApiClient api;
  final SessionMachine machine = SessionMachine();
  late final LiveSocket socket;

  String baseUrl = '';
  String token = '';
  ServerConfig? config;
  bool ready = false;
  bool socketConnected = false;
  bool writeEnabled = false;
  String? connectError;
  List<SessionSummary> sessions = [];
  bool restoringSession = false;

  String themeId = 'light';
  bool serif = false;
  double fontSize = 16;
  bool showProcess = true;
  bool attachDocument = false;
  String? selectedPreviewText;
  OpenDocument? openDocument;
  String? documentNotice;
  final List<ChatImage> draftImages = [];

  static const _baseKey = 'base-url';
  static const _tokenKey = 'access-token';
  static const _writeKey = 'write-permission';

  Future<void> loadSaved() async {
    baseUrl = await storage.read(key: _baseKey) ?? '';
    token = await storage.read(key: _tokenKey) ?? '';
    writeEnabled = (await storage.read(key: _writeKey)) == 'true';
    final prefs = await SharedPreferences.getInstance();
    themeId = prefs.getString('appearance-theme') ?? 'light';
    if (themeId != 'light' && themeId != 'daylight' && themeId != 'monochrome') themeId = 'light';
    serif = prefs.getBool('appearance-serif') ?? false;
    fontSize = prefs.getDouble('appearance-font-size') ?? 16;
    showProcess = prefs.getBool('appearance-show-process') ?? true;
    attachDocument = prefs.getBool('attach-document') ?? false;
    WidgetsBinding.instance.addObserver(this);
    notifyListeners();
  }

  Future<String?> signIn(String rawBase, String rawToken) async {
    final normalized = normalizeBaseUrl(rawBase);
    if (normalized.isEmpty) return '请输入服务器地址';
    try {
      final health = await api.getJson(apiUri(normalized, '/health'));
      final authRequired = health['authRequired'] == true;
      if (authRequired && rawToken.trim().isEmpty) return '请输入 access token';
      final configJson = await api.getJson(
        apiUri(normalized, '/api/config'),
        token: rawToken.trim(),
      );
      config = ServerConfig.fromJson(configJson);
      baseUrl = normalized;
      token = rawToken.trim();
      connectError = null;
      ready = true;
      await storage.write(key: _baseKey, value: baseUrl);
      await storage.write(key: _tokenKey, value: token);
      await socket.connect(webSocketUri(baseUrl, token));
      notifyListeners();
      return null;
    } on ApiException catch (error) {
      ready = false;
      return error.unauthorized ? '凭证无效' : error.message;
    }
  }

  Future<T> _guard<T>(Future<T> future) async {
    try {
      return await future;
    } on ApiException catch (error) {
      if (error.unauthorized) _onAuthRejected();
      rethrow;
    }
  }

  Future<void> refreshSessions() => _guard(_refreshSessions());

  Future<void> _refreshSessions() async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/sessions'), token: token);
    final raw = payload['sessions'];
    final next = <SessionSummary>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is! Map) continue;
        next.add(SessionSummary(
          id: '${item['id'] ?? ''}',
          title: '${item['title'] ?? ''}',
          updatedAt: '${item['updatedAt'] ?? ''}',
        ));
      }
    }
    sessions = next;
    notifyListeners();
  }

  Future<String?> lastActiveSessionId() => _guard(_lastActiveSessionId());

  Future<String?> _lastActiveSessionId() async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/app-state'), token: token);
    final id = payload['lastActiveSessionId'];
    return id is String && id.isNotEmpty ? id : null;
  }

  Future<SessionSummary> createSession() => _guard(_createSession());

  Future<SessionSummary> _createSession() async {
    final payload = await api.sendJson(
      'POST',
      apiUri(baseUrl, '/api/sessions'),
      token: token,
      body: {},
    );
    final session = payload['session'];
    final summary = SessionSummary(
      id: session is Map ? '${session['id'] ?? ''}' : '',
      title: session is Map ? '${session['title'] ?? ''}' : '',
      updatedAt: session is Map ? '${session['updatedAt'] ?? ''}' : '',
    );
    await _refreshSessions();
    return summary;
  }

  Future<void> renameSession(String id, String title) => _guard(_renameSession(id, title));

  Future<void> _renameSession(String id, String title) async {
    await api.sendJson(
      'PATCH',
      apiUri(baseUrl, '/api/sessions/$id'),
      token: token,
      body: {'title': title},
    );
    await _refreshSessions();
  }

  Future<void> deleteSession(String id) => _guard(_deleteSession(id));

  Future<void> _deleteSession(String id) async {
    await api.sendJson('DELETE', apiUri(baseUrl, '/api/sessions/$id'), token: token);
    await _refreshSessions();
  }

  void openSession(String sessionId) => machine.selectSession(sessionId);

  bool sendChat(String text) {
    final sessionId = machine.currentSessionId;
    final active = config;
    final runtime = machine.current;
    if (sessionId == null || active == null || text.trim().isEmpty) return false;
    if (!socket.isOpen) {
      machine.runtimeOf(sessionId).errorMessage = '未连接';
      notifyListeners();
      return false;
    }
    if (runtime?.isStreaming == true) {
      machine.cancelCurrent();
      return true;
    }
    final provider = runtime?.lastProvider?.isNotEmpty == true
        ? runtime!.lastProvider!
        : draftProvider;
    final model = runtime?.lastModel?.isNotEmpty == true ? runtime!.lastModel! : draftModel;
    final thinking = runtime?.lastThinkingEffort?.isNotEmpty == true
        ? runtime!.lastThinkingEffort!
        : draftThinking;
    machine.runtimeOf(sessionId).messages.add(DisplayMessage(
      id: 'local-${DateTime.now().microsecondsSinceEpoch}',
      role: 'user',
      text: text.trim(),
      images: [
        for (final image in draftImages) ChatImage(url: image.url, path: image.path),
      ],
    ));
    final modelChoice = active.findModel(provider, model);
    List<Map<String, String>>? images;
    if (draftImages.isNotEmpty) {
      if (modelChoice?.vision != true) {
        machine.runtimeOf(sessionId).messages.removeLast();
        machine.runtimeOf(sessionId).errorMessage = '当前模型不支持图片，请切换到视觉模型后再发送';
        notifyListeners();
        return false;
      }
      images = [
        for (final image in draftImages) {'url': image.url, if (image.path != null) 'path': image.path!},
      ];
    }
    final preview = attachDocument ? openDocument?.path : null;
    final selection = attachDocument ? selectedPreviewText : null;
    socket.send(chatMessagePayload(
      sessionId: sessionId,
      content: text.trim(),
      provider: provider,
      model: model,
      thinkingEffort: thinking,
      images: images,
      previewPath: preview,
      selectedPreviewText: selection,
    ));
    draftImages.clear();
    if (attachDocument) selectedPreviewText = null;
    notifyListeners();
    return true;
  }

  String draftProvider = '';
  String draftModel = '';
  String draftThinking = '';

  void ensureDraft() {
    final active = config;
    final runtime = machine.current;
    if (active == null) return;
    draftProvider = runtime?.lastProvider?.isNotEmpty == true
        ? runtime!.lastProvider!
        : active.defaultProvider;
    draftModel = runtime?.lastModel?.isNotEmpty == true ? runtime!.lastModel! : active.defaultModel;
    draftThinking = runtime?.lastThinkingEffort?.isNotEmpty == true
        ? runtime!.lastThinkingEffort!
        : active.defaultThinkingEffort;
    draftThinking = active.alignThinking(draftProvider, draftModel, draftThinking);
    if (runtime != null) {
      runtime.lastProvider = draftProvider;
      runtime.lastModel = draftModel;
      runtime.lastThinkingEffort = draftThinking;
    }
  }

  void chooseProvider(String provider) {
    final active = config;
    if (active == null) return;
    draftProvider = provider;
    final models = active.modelsFor(provider);
    draftModel = models.isEmpty ? active.defaultModel : models.first.id;
    draftThinking = active.alignThinking(draftProvider, draftModel, draftThinking);
    _storeDraft();
  }

  void chooseModel(String modelId) {
    final active = config;
    if (active == null) return;
    draftModel = modelId;
    draftThinking = active.alignThinking(draftProvider, draftModel, draftThinking);
    _storeDraft();
  }

  void chooseThinking(String thinking) {
    draftThinking = thinking;
    _storeDraft();
  }

  void _storeDraft() {
    final runtime = machine.current;
    if (runtime == null) return;
    runtime.lastProvider = draftProvider;
    runtime.lastModel = draftModel;
    runtime.lastThinkingEffort = draftThinking;
    notifyListeners();
  }

  void dismissError(String sessionId) {
    machine.runtimeOf(sessionId).errorMessage = null;
    notifyListeners();
  }

  void showSessionError(String sessionId, String message) {
    machine.runtimeOf(sessionId).errorMessage = message;
    notifyListeners();
  }

  void dismissConnectionError() {
    machine.connectionError = null;
    notifyListeners();
  }

  Future<void> setTheme(String id) async {
    themeId = id;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('appearance-theme', id);
  }

  Future<void> setSerif(bool value) async {
    serif = value;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('appearance-serif', value);
  }

  Future<void> setFontSize(double value) async {
    fontSize = value;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble('appearance-font-size', value);
  }

  Future<void> setShowProcess(bool value) async {
    showProcess = value;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('appearance-show-process', value);
  }

  Future<void> setAttachDocument(bool value) async {
    attachDocument = value;
    if (!value) selectedPreviewText = null;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('attach-document', value);
  }

  void setSelectedPreview(String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    selectedPreviewText = trimmed;
    notifyListeners();
  }

  void clearSelectedPreview() {
    selectedPreviewText = null;
    notifyListeners();
  }

  void addDraftImage(ChatImage image) {
    draftImages.add(image);
    notifyListeners();
  }

  void removeDraftImage(ChatImage image) {
    draftImages.remove(image);
    notifyListeners();
  }

  Future<List<FileHit>> searchFiles(String query) => _quiet(_searchFiles(query));

  Future<List<FileHit>> _searchFiles(String query) async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/files', {'q': query}), token: token);
    final raw = payload['files'];
    if (raw is! List) return [];
    return [
      for (final item in raw)
        if (item is Map)
          FileHit(path: '${item['path'] ?? ''}', name: item['name'] as String?, source: '${item['source'] ?? ''}'),
    ].where((item) => item.path.isNotEmpty).toList();
  }

  Future<List<CommandHit>> searchCommands(String query) => _quiet(_searchCommands(query));

  Future<List<CommandHit>> _searchCommands(String query) async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/commands', {'q': query}), token: token);
    final raw = payload['commands'];
    if (raw is! List) return [];
    return [
      for (final item in raw)
        if (item is Map) CommandHit(name: '${item['name'] ?? ''}', prompt: '${item['prompt'] ?? ''}'),
    ].where((item) => item.name.isNotEmpty).toList();
  }

  Future<void> truncateSession(String sessionId, String messageId) async {
    await _guard(api.sendJson(
      'POST',
      apiUri(baseUrl, '/api/sessions/$sessionId/truncate'),
      token: token,
      body: {'messageId': messageId},
    ));
    machine.selectSession(sessionId);
  }

  Future<void> compactSession(String sessionId, int keepRecentRounds) async {
    await _guard(api.sendJson(
      'POST',
      apiUri(baseUrl, '/api/sessions/$sessionId/compact'),
      token: token,
      body: {'keepRecentRounds': keepRecentRounds},
    ));
    machine.selectSession(sessionId);
  }

  Future<List<KnowledgeBase>> loadKnowledge() => _guard(_loadKnowledge());

  Future<List<KnowledgeBase>> _loadKnowledge() async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/knowledge'), token: token);
    final raw = payload['bases'];
    if (raw is! List) return [];
    return [
      for (final item in raw)
        if (item is Map)
          KnowledgeBase(
            name: '${item['name'] ?? ''}',
            description: '${item['description'] ?? ''}',
            files: [
              for (final file in item['files'] is List ? item['files'] as List : const []) '$file',
            ],
          ),
    ];
  }

  Future<List<TreeEntry>> loadTree(String path) => _guard(_loadTree(path));

  Future<List<TreeEntry>> _loadTree(String path) async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/documents/tree', {'path': path}), token: token);
    final raw = payload['entries'];
    if (raw is! List) return [];
    return [
      for (final item in raw)
        if (item is Map)
          TreeEntry(
            name: '${item['name'] ?? ''}',
            path: '${item['path'] ?? ''}',
            kind: '${item['kind'] ?? ''}',
          ),
    ];
  }

  Future<bool> openDocumentAt(String path) async {
    try {
      final payload = await _guard(_loadDocument(path));
      openDocument = payload;
      documentNotice = null;
      notifyListeners();
      return true;
    } on ApiException catch (error) {
      openDocument = null;
      documentNotice = error.statusCode == 404 ? '文件不存在或已被删除' : error.message;
      notifyListeners();
      return false;
    }
  }

  Future<OpenDocument> _loadDocument(String path) async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/documents/content', {'path': path}), token: token);
    return OpenDocument(
      path: '${payload['path'] ?? path}',
      title: payload['title'] as String?,
      content: '${payload['content'] ?? ''}',
      kind: '${payload['kind'] ?? 'unsupported'}',
    );
  }

  Future<String?> saveDocument(String path, String content) async {
    try {
      await _guard(api.sendJson(
        'PUT',
        apiUri(baseUrl, '/api/documents/content'),
        token: token,
        body: {'path': path, 'content': content},
      ));
      if (openDocument?.path == path) {
        openDocument = OpenDocument(
          path: path,
          title: openDocument?.title,
          content: content,
          kind: openDocument?.kind ?? 'text',
        );
      }
      notifyListeners();
      return null;
    } on ApiException catch (error) {
      if (error.statusCode == 404) {
        openDocument = null;
        documentNotice = '文件不存在或已被删除';
        notifyListeners();
      }
      return error.statusCode == 404 ? '文件不存在或已被删除' : error.message;
    }
  }

  void closeDocument() {
    openDocument = null;
    notifyListeners();
  }

  Future<List<UsageDay>> loadUsageDaily(int days) => _guard(_loadUsageDaily(days));

  Future<List<UsageDay>> _loadUsageDaily(int days) async {
    final payload = await api.getJsonAny(apiUri(baseUrl, '/api/usage/daily', {'days': '$days'}), token: token);
    if (payload is! List) return [];
    return [
      for (final item in payload)
        if (item is Map)
          UsageDay(
            date: '${item['date'] ?? ''}',
            totalTokens: _num(item['totalTokens']),
            totalCost: _num(item['totalCost']),
          ),
    ];
  }

  Future<List<UsageStat>> loadUsageStats() => _guard(_loadUsageStats());

  Future<List<UsageStat>> _loadUsageStats() async {
    final payload = await api.getJsonAny(apiUri(baseUrl, '/api/usage/stats'), token: token);
    if (payload is! List) return [];
    return [
      for (final item in payload)
        if (item is Map)
          UsageStat(
            provider: '${item['provider'] ?? ''}',
            model: '${item['model'] ?? ''}',
            inputTokens: _num(item['inputTokens']),
            outputTokens: _num(item['outputTokens']),
            billingOutputTokens: _num(item['billingOutputTokens']),
            cost: _num(item['cost']),
          ),
    ];
  }

  Future<void> flushUsage() => _guard(api.sendJson('POST', apiUri(baseUrl, '/api/usage/flush'), token: token));

  Future<T> _quiet<T>(Future<T> future) async {
    try {
      return await future;
    } on ApiException catch (error) {
      if (error.unauthorized) _onAuthRejected();
      rethrow;
    }
  }

  Future<void> setWriteEnabled(bool enabled) async {
    writeEnabled = enabled;
    await storage.write(key: _writeKey, value: enabled ? 'true' : 'false');
    machine.setWritePermission(enabled);
    notifyListeners();
  }

  Future<void> logout() async {
    machine.logout();
    await socket.stop();
    await storage.delete(key: _tokenKey);
    token = '';
    ready = false;
    connectError = null;
    notifyListeners();
  }

  void _onAuthRejected() {
    ready = false;
    connectError = '凭证无效';
    notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      socket.resume();
    } else if (state == AppLifecycleState.paused || state == AppLifecycleState.detached) {
      socket.pause();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

double _num(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse('$value') ?? 0;
}

class OpenDocument {
  const OpenDocument({required this.path, this.title, required this.content, required this.kind});

  final String path;
  final String? title;
  final String content;
  final String kind;

  bool get canSave => kind == 'text' && !path.startsWith('trilium:');
  String get displayTitle => (title != null && title!.isNotEmpty) ? title! : path;
}

class TreeEntry {
  const TreeEntry({required this.name, required this.path, required this.kind});
  final String name;
  final String path;
  final String kind;
}

class KnowledgeBase {
  const KnowledgeBase({required this.name, required this.description, required this.files});
  final String name;
  final String description;
  final List<String> files;
}

class FileHit {
  const FileHit({required this.path, this.name, required this.source});
  final String path;
  final String? name;
  final String source;
  String get label => (name != null && name!.isNotEmpty) ? name! : path;
}

class CommandHit {
  const CommandHit({required this.name, required this.prompt});
  final String name;
  final String prompt;
}

class UsageDay {
  const UsageDay({required this.date, required this.totalTokens, required this.totalCost});
  final String date;
  final double totalTokens;
  final double totalCost;
}

class UsageStat {
  const UsageStat({
    required this.provider,
    required this.model,
    required this.inputTokens,
    required this.outputTokens,
    required this.billingOutputTokens,
    required this.cost,
  });

  final String provider;
  final String model;
  final double inputTokens;
  final double outputTokens;
  final double billingOutputTokens;
  final double cost;
}
