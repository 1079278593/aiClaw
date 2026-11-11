import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api_client.dart';
import 'app_update.dart';
import 'chat_models.dart';
import 'context_sources.dart';
import 'live_socket.dart';
import 'session_machine.dart';

class SessionSummary {
  SessionSummary({required this.id, required this.title, required this.updatedAt});
  final String id;
  final String title;
  final String updatedAt;
}

class PersonDraft {
  String text = '';
  var mine = false;
  var note = false;
}

class PersonConsult {
  const PersonConsult({
    required this.personId,
    required this.name,
    required this.canOrganize,
    this.previewPath,
    this.selectedText,
  });

  final String personId;
  final String name;
  final bool canOrganize;
  final String? previewPath;
  final String? selectedText;
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
  final personDrafts = <String, PersonDraft>{};

  PersonDraft draftForPerson(String id) => personDrafts.putIfAbsent(id, PersonDraft.new);

  void clearPersonDrafts() => personDrafts.clear();

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
      await socket.connect(webSocketUri(baseUrl), token: token);
      notifyListeners();
      return null;
    } on ApiException catch (error) {
      ready = false;
      return error.unauthorized ? '凭证无效' : error.message;
    }
  }

  Future<void> adoptAccessToken(String next) async {
    token = next.trim();
    await storage.write(key: _tokenKey, value: token);
    await socket.connect(webSocketUri(baseUrl), token: token);
    notifyListeners();
  }

  Future<void> refreshAfterAccountChange() async {
    final configJson = await api.getJson(apiUri(baseUrl, '/api/config'), token: token);
    config = ServerConfig.fromJson(configJson);
    await socket.connect(webSocketUri(baseUrl), token: token);
    notifyListeners();
  }

  /// 查询 App 更新。
  ///
  /// 走本服务而不是直连 fir：fir 的 token 是账号级凭据，
  /// 客户端包可被解包，token 绝不能进安装包。详见服务端 `src/app-update`。
  ///
  /// 平台由 `defaultTargetPlatform` 决定；Android 尚未上传过包时，
  /// 服务端会返回 `available:false`，调用方按「暂无」处理即可。
  ///
  /// 失败时返回 null 而不是抛异常：更新检查是附加功能，
  /// 它坏掉不该影响「更多」页面其它内容。
  Future<AppUpdateInfo?> checkAppUpdate() async {
    if (baseUrl.isEmpty) return null;
    final platform = defaultTargetPlatform == TargetPlatform.android ? 'android' : 'ios';
    try {
      final payload = await _guard(
        api.getJson(apiUri(baseUrl, '/api/app/update', {'platform': platform}), token: token),
      );
      return AppUpdateInfo.tryParse(payload);
    } on ApiException {
      return null;
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

  /// 心得对话用的独立会话（plan_reflections_chat.md §7.4）。
  /// 它不出现在聊天列表里，join 时也不会覆盖 `lastActiveSessionId`。
  String? reflectionsSessionId;

  /// 「待应用」角标数字，进心得首页与一轮对话结束后刷新。
  int pendingBadge = 0;

  /// 打开心得对话：读 `app_state.reflectionsSessionId`，
  /// 会话不存在就新建一个并回写。返回可用的会话 id。
  Future<String?> openReflectionsSession() => _guard(_openReflectionsSession());

  Future<String?> _openReflectionsSession() async {
    final state = await api.getJson(apiUri(baseUrl, '/api/app-state'), token: token);
    final stored = state['reflectionsSessionId'];
    final storedId = stored is String && stored.isNotEmpty ? stored : null;
    if (storedId != null) {
      // 会话可能已被删除（本机或别的客户端），确认存在后再用。
      try {
        if (await _sessionExists(storedId)) {
          reflectionsSessionId = storedId;
          notifyListeners();
          return storedId;
        }
      } on ApiException {
        // 探测失败时退回新建，避免卡在弹层门口。
      }
    }
    final created = await _createSession();
    if (created.id.isEmpty) return null;
    await api.sendJson(
      'POST',
      apiUri(baseUrl, '/api/app-state/reflections-session'),
      token: token,
      body: {'sessionId': created.id},
    );
    reflectionsSessionId = created.id;
    notifyListeners();
    return created.id;
  }

  /// 心得会话被 `GET /api/sessions` 过滤掉了，所以单独探测。
  Future<bool> _sessionExists(String sessionId) async {
    try {
      await api.getJson(apiUri(baseUrl, '/api/sessions/$sessionId'), token: token);
      return true;
    } on ApiException catch (error) {
      if (error.statusCode == 404) return false;
      rethrow;
    }
  }

  Future<void> refreshPendingBadge() => _guard(_refreshPendingBadge());

  Future<void> _refreshPendingBadge() async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/pending'), token: token);
    final badge = payload['badge'];
    pendingBadge = badge is num ? badge.toInt() : 0;
    notifyListeners();
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

  bool sendChat(String text, {PersonConsult? person, bool organize = false}) {
    final sessionId = machine.currentSessionId;
    final active = config;
    final runtime = machine.current;
    final outgoing = organize ? '整理目前新增的内容。' : text;
    if (sessionId == null || active == null || outgoing.trim().isEmpty) return false;
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
      text: outgoing.trim(),
      images: organize
          ? const []
          : [
              for (final image in draftImages) ChatImage(url: image.url, path: image.path),
            ],
    ));
    final modelChoice = active.findModel(provider, model);
    List<Map<String, String>>? images;
    if (!organize && draftImages.isNotEmpty) {
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
    final preview = person != null ? person.previewPath : (attachDocument ? openDocument?.path : null);
    final selection = person != null ? person.selectedText : (attachDocument ? selectedPreviewText : null);
    socket.send(chatMessagePayload(
      sessionId: sessionId,
      content: outgoing.trim(),
      provider: provider,
      model: model,
      thinkingEffort: thinking,
      images: organize ? null : images,
      previewPath: preview,
      selectedPreviewText: selection,
      threadPath: person == null ? null : 'people/${person.personId}',
      captureJob: organize ? 'organize' : null,
    ));
    if (!organize) draftImages.clear();
    if (person == null && attachDocument) selectedPreviewText = null;
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

  /// 「上下文来源」：每轮必带的内容各占多少 token，并允许逐块修改。
  ///
  /// 走 `_guard`：这块数据和别的请求一样会因令牌失效而 401。
  Future<ContextOverview> loadContextSources() => _guard(_loadContextSources());

  Future<ContextOverview> _loadContextSources() async {
    final payload = await api.getJson(apiUri(baseUrl, '/api/context/sources'), token: token);
    final overview = ContextOverview.tryParse(payload);
    if (overview == null) {
      throw ApiException(500, '上下文来源返回格式不对');
    }
    return overview;
  }

  /// 提交改动的块。服务端逐条处理，一条失败不影响其他条。
  ///
  /// 注意不能用 `sendJson`：局部失败时服务端返回 **400 且带完整结果体**，
  /// 而 `sendJson` 见到 4xx 直接抛异常，丢掉的正是「哪一条没成、为什么」。
  Future<ContextSaveResult> saveContextSources(
    Map<String, String> updates,
  ) => _guard(_saveContextSources(updates));

  Future<ContextSaveResult> _saveContextSources(Map<String, String> updates) async {
    // 与其它需要读错误体的请求保持一致，这里直接按「成功/失败都要 body」处理。
    final result = await api.sendJsonAllowError(
      'PUT',
      apiUri(baseUrl, '/api/context/sources'),
      token: token,
      body: {
        'updates': [
          for (final entry in updates.entries) {'id': entry.key, 'content': entry.value},
        ],
      },
    );
    final parsed = ContextSaveResult.from(result.body);
    if (result.statusCode >= 400 && parsed.failed.isEmpty) {
      // 没有任何逐条信息时，退回服务端的整体错误文案。
      throw ApiException(result.statusCode, result.error ?? '保存失败');
    }
    return parsed;
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
    clearPersonDrafts();
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
    clearPersonDrafts();
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
