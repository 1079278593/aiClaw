import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// 前台断线每 3 秒重连；4401 停止。ping 帧由 dart:io WebSocket 自动回复。
class LiveSocket {
  LiveSocket({
    required this.onMessage,
    required this.onAuthRejected,
    required this.onStatus,
  });

  final void Function(Map<String, Object?> message) onMessage;
  final void Function() onAuthRejected;
  final void Function(bool connected) onStatus;

  WebSocket? _socket;
  Timer? _retry;
  Uri? _uri;
  bool foreground = true;
  bool _stopped = false;
  bool _authRejected = false;

  bool get isOpen => _socket?.readyState == WebSocket.open;

  Future<void> connect(Uri uri) async {
    _uri = uri;
    _stopped = false;
    _authRejected = false;
    _retry?.cancel();
    await _open();
  }

  Future<void> _open() async {
    final uri = _uri;
    if (uri == null || _stopped || _authRejected) return;
    try {
      final socket = await WebSocket.connect(uri.toString());
      socket.listen(
        (data) {
          final decoded = jsonDecode('$data');
          if (decoded is Map) onMessage(Map<String, Object?>.from(decoded));
        },
        onError: (_) => _handleClose(socket, null),
        onDone: () => _handleClose(socket, socket.closeCode),
        cancelOnError: true,
      );
      final previous = _socket;
      _socket = socket;
      onStatus(true);
      if (previous != null) unawaited(previous.close());
    } catch (_) {
      onStatus(false);
      _scheduleRetry();
    }
  }

  void _handleClose(WebSocket socket, int? code) {
    if (!identical(_socket, socket) && _socket != null) return;
    onStatus(false);
    _socket = null;
    if (code == 4401) {
      _authRejected = true;
      _retry?.cancel();
      onAuthRejected();
      return;
    }
    _scheduleRetry();
  }

  void _scheduleRetry() {
    if (!foreground || _stopped || _authRejected || _uri == null) return;
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 3), _open);
  }

  void send(Map<String, Object?> message) {
    final socket = _socket;
    if (socket == null || socket.readyState != WebSocket.open) return;
    socket.add(jsonEncode(message));
  }

  void pause() {
    foreground = false;
    _retry?.cancel();
  }

  void resume() {
    foreground = true;
    if (_stopped || _authRejected || _uri == null) return;
    if (!isOpen) {
      _retry?.cancel();
      _open();
    }
  }

  Future<void> stop() async {
    _stopped = true;
    _retry?.cancel();
    await _socket?.close();
    _socket = null;
    onStatus(false);
  }
}
