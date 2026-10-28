import 'chat_models.dart';

/// 多会话运行时。行为以 mobile/docs/session_runtime.md 为准。
class SessionMachine {
  final Map<String, SessionRuntime> cache = {};
  String? currentSessionId;
  String? sessionLoadRequestId;
  String? connectionError;
  bool permissionVisible = false;
  final List<Map<String, Object?>> outbound = [];

  /// 界面或 WebSocket 发送出口。测试可只读 [outbound]。
  void Function(Map<String, Object?> message)? onSend;
  void Function()? onChanged;

  int _requestSerial = 0;

  SessionRuntime? get current =>
      currentSessionId == null ? null : cache[currentSessionId!];

  SessionRuntime runtimeOf(String sessionId) =>
      cache.putIfAbsent(sessionId, SessionRuntime.new);

  void selectSession(String sessionId) {
    permissionVisible = false;
    currentSessionId = sessionId;
    final runtime = runtimeOf(sessionId);
    final pending = List<Map<String, Object?>>.of(runtime.pendingEvents);
    runtime.pendingEvents.clear();
    for (final event in pending) {
      _apply(runtime, event);
    }
    permissionVisible = runtime.pendingPermission != null;
    sessionLoadRequestId = 'join-${++_requestSerial}';
    _send({
      'type': 'joinSession',
      'sessionId': sessionId,
      'requestId': sessionLoadRequestId,
    });
    _emit();
  }

  void onServerMessage(Map<String, Object?> event) {
    final type = event['type'] as String?;
    if (type == 'connected' || type == 'pong') {
      _emit();
      return;
    }
    if (type == 'sessionLoaded') {
      _applySessionLoaded(event);
      _emit();
      return;
    }
    final sessionId = event['sessionId'] as String?;
    if (type == 'error' && sessionId == null) {
      connectionError = event['message'] as String? ?? '连接错误';
      _emit();
      return;
    }
    if (sessionId == null) {
      _emit();
      return;
    }
    final runtime = runtimeOf(sessionId);
    if (sessionId != currentSessionId) {
      runtime.pendingEvents.add(event);
      _emit();
      return;
    }
    _apply(runtime, event);
    _emit();
  }

  void respondPermission(bool allowed) {
    final runtime = current;
    final pending = runtime?.pendingPermission;
    if (runtime == null || pending == null) return;
    _send({
      'type': 'toolPermissionResponse',
      'requestId': pending['requestId'],
      'allowed': allowed,
    });
    runtime.pendingPermission = null;
    permissionVisible = false;
    _emit();
  }

  void cancelCurrent() {
    final sessionId = currentSessionId;
    final runtime = current;
    if (sessionId == null || runtime == null) return;
    _send({'type': 'cancelChat', 'sessionId': sessionId});
    final pending = runtime.pendingPermission;
    if (pending != null) {
      _send({
        'type': 'toolPermissionResponse',
        'requestId': pending['requestId'],
        'allowed': false,
      });
      runtime.pendingPermission = null;
      permissionVisible = false;
    }
    _emit();
  }

  void setWritePermission(bool enabled) {
    _send({'type': 'setWritePermission', 'enabled': enabled});
    _emit();
  }

  /// 用户主动退出。未决权限发送拒绝。
  void logout() {
    for (final runtime in cache.values) {
      final pending = runtime.pendingPermission;
      if (pending == null) continue;
      _send({
        'type': 'toolPermissionResponse',
        'requestId': pending['requestId'],
        'allowed': false,
      });
      runtime.pendingPermission = null;
    }
    permissionVisible = false;
    _emit();
  }

  void _applySessionLoaded(Map<String, Object?> event) {
    if (event['requestId'] != sessionLoadRequestId) return;
    final session = event['session'];
    if (session is! Map) return;
    final sessionId = session['id'] as String?;
    if (sessionId == null) return;
    final runtime = runtimeOf(sessionId);
    runtime.title = session['title'] as String?;
    runtime.lastProvider = session['lastProvider'] as String?;
    runtime.lastModel = session['lastModel'] as String?;
    runtime.lastThinkingEffort = session['lastThinkingEffort'] as String?;
    final snapshot = parseHistory(session['messages']);
    if (!runtime.isStreaming && snapshot.length != runtime.messages.length) {
      _adoptSnapshot(runtime, snapshot);
    }
  }

  /// 条数不同时用快照替换。快照若只是本地列表的前缀，末尾尚未落盘的本地用户消息保留。
  void _adoptSnapshot(SessionRuntime runtime, List<DisplayMessage> snapshot) {
    final local = runtime.messages;
    if (snapshot.length < local.length && _samePrefix(local, snapshot)) {
      final extra = local.sublist(snapshot.length);
      if (extra.every((message) => message.id.startsWith('local-'))) {
        local
          ..clear()
          ..addAll(snapshot)
          ..addAll(extra);
        return;
      }
    }
    local
      ..clear()
      ..addAll(snapshot);
  }

  bool _samePrefix(List<DisplayMessage> local, List<DisplayMessage> snapshot) {
    for (var index = 0; index < snapshot.length; index++) {
      if (local[index].id != snapshot[index].id) return false;
    }
    return true;
  }

  void _apply(SessionRuntime runtime, Map<String, Object?> event) {
    final type = event['type'] as String?;
    if (type == 'error') {
      _applyError(runtime, event);
      return;
    }
    if (type == 'chatStart') {
      runtime.currentRunId = event['runId'] as String?;
      runtime.lastSequence = (event['sequence'] as num?)?.toInt() ?? 0;
      runtime.isStreaming = true;
      runtime.messages.add(DisplayMessage(
        id: 'run-${event['runId']}',
        role: 'assistant',
        runId: event['runId'] as String?,
      ));
      return;
    }
    if (!_acceptStream(runtime, event)) return;
    runtime.lastSequence = (event['sequence'] as num).toInt();
    final assistant = _assistantForRun(runtime, event['runId'] as String?);
    switch (type) {
      case 'chatChunk':
        assistant?.text += event['chunk'] as String? ?? '';
      case 'chatReasoning':
        assistant?.reasoning += event['chunk'] as String? ?? '';
      case 'toolCall':
        assistant?.tools.add(ToolBlock(
          callId: event['callId'] as String? ?? '',
          name: event['name'] as String? ?? '',
          arguments: '${event['input'] ?? ''}',
        ));
      case 'toolResult':
        final callId = event['callId'] as String? ?? '';
        final tools = assistant?.tools ?? const <ToolBlock>[];
        for (final tool in tools.reversed) {
          if (tool.callId != callId) continue;
          tool.result = event['content'] as String? ?? '';
          tool.isError = event['isError'] == true;
          break;
        }
      case 'toolPermissionRequest':
        runtime.pendingPermission = event;
        if (runtime == current) permissionVisible = true;
      case 'chatEnd':
        if (event['fullResponse'] is String) {
          assistant?.text = event['fullResponse'] as String;
        }
        runtime.isStreaming = false;
      case 'chatCancelled':
        if (event['fullResponse'] is String) {
          assistant?.text = event['fullResponse'] as String;
        }
        runtime.isStreaming = false;
        runtime.pendingPermission = null;
        if (runtime == current) permissionVisible = false;
    }
  }

  void _applyError(SessionRuntime runtime, Map<String, Object?> event) {
    final sequence = event['sequence'];
    if (sequence == null) {
      runtime.errorMessage = event['message'] as String? ?? '错误';
      return;
    }
    if (!_acceptStream(runtime, event)) return;
    runtime.lastSequence = (sequence as num).toInt();
    runtime.isStreaming = false;
    runtime.errorMessage = event['message'] as String? ?? '错误';
  }

  bool _acceptStream(SessionRuntime runtime, Map<String, Object?> event) {
    if (event['runId'] != runtime.currentRunId) return false;
    final sequence = event['sequence'];
    if (sequence is! num) return false;
    if (sequence.toInt() <= runtime.lastSequence) return false;
    if (!runtime.isStreaming) return false;
    return true;
  }

  DisplayMessage? _assistantForRun(SessionRuntime runtime, String? runId) {
    for (final message in runtime.messages.reversed) {
      if (message.role == 'assistant' && message.runId == runId) return message;
    }
    return null;
  }

  void _send(Map<String, Object?> message) {
    outbound.add(message);
    onSend?.call(message);
  }

  void _emit() => onChanged?.call();
}

class SessionRuntime {
  final List<DisplayMessage> messages = [];
  bool isStreaming = false;
  String? currentRunId;
  int lastSequence = 0;
  final List<Map<String, Object?>> pendingEvents = [];
  Map<String, Object?>? pendingPermission;
  String? errorMessage;
  String? title;
  String? lastProvider;
  String? lastModel;
  String? lastThinkingEffort;
}
