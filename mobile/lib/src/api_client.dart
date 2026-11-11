import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class ApiException implements Exception {
  ApiException(this.statusCode, this.message);
  final int statusCode;
  final String message;
  bool get unauthorized => statusCode == 401;
}

class ApiClient {
  Future<Map<String, Object?>> getJson(Uri uri, {String token = ''}) async {
    final response = await _send('GET', uri, token: token);
    return _decodeObject(response.body);
  }

  /// 下载二进制内容。
  ///
  /// 报错文案**不能写死成「图片加载失败」**：这个方法同时用于图片和语音，
  /// 写死过一次，结果语音取不到时也显示「图片加载失败」，
  /// 把「路径引用错了」误导成「图片服务坏了」。所以让调用方传文案。
  Future<Uint8List> getBytes(Uri uri, {String token = '', String errorMessage = '加载失败'}) async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(uri);
      if (token.isNotEmpty) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      }
      final response = await request.close();
      final bytes = await response.fold<BytesBuilder>(
        BytesBuilder(),
        (builder, chunk) => builder..add(chunk),
      );
      final payload = bytes.takeBytes();
      if (response.statusCode >= 400) {
        // 服务端会说明具体原因（如「文件不存在或已被删除」），比通用文案有用得多。
        throw ApiException(
          response.statusCode,
          _errorMessage(utf8.decode(payload, allowMalformed: true)) ?? errorMessage,
        );
      }
      return payload;
    } finally {
      client.close();
    }
  }

  Future<Object?> getJsonAny(Uri uri, {String token = ''}) async {
    final response = await _send('GET', uri, token: token);
    if (response.body.isEmpty) return null;
    return jsonDecode(response.body);
  }

  Future<Map<String, Object?>> sendJson(
    String method,
    Uri uri, {
    String token = '',
    Map<String, Object?>? body,
  }) async {
    final response = await _send(method, uri, token: token, body: body);
    return _decodeObject(response.body);
  }

  /// 与 `sendJson` 相同，但 **4xx/5xx 不抛异常**，把状态码和响应体一起返回。
  ///
  /// 用于「部分成功」语义的接口：服务端在 400 里同时给出已保存的列表、
  /// 逐条失败原因和最新统计。用 `sendJson` 会把这些信息连同异常一起丢掉，
  /// 界面就只能说一句「保存失败」，用户不知道是哪一块、为什么。
  /// 401 仍然抛出——那是凭证问题，不是业务结果。
  Future<ApiResult> sendJsonAllowError(
    String method,
    Uri uri, {
    String token = '',
    Map<String, Object?>? body,
  }) async {
    final response = await _sendAllowError(method, uri, token: token, body: body);
    return ApiResult(response.statusCode, _decodeObject(response.body));
  }

  Future<Map<String, Object?>> postMultipart(
    Uri uri, {
    required String token,
    required Map<String, String> fields,
    required List<({String filename, Uint8List bytes, String mime})> files,
    String fileField = 'images',
  }) async {
    final boundary = 'aiclaw-${DateTime.now().microsecondsSinceEpoch}';
    final builder = BytesBuilder();
    void add(String text) => builder.add(utf8.encode(text));
    for (final entry in fields.entries) {
      add('--$boundary\r\n');
      add('Content-Disposition: form-data; name="${entry.key}"\r\n\r\n');
      add('${entry.value}\r\n');
    }
    for (final file in files) {
      add('--$boundary\r\n');
      add('Content-Disposition: form-data; name="$fileField"; filename="${file.filename}"\r\n');
      add('Content-Type: ${file.mime}\r\n\r\n');
      builder.add(file.bytes);
      add('\r\n');
    }
    add('--$boundary--\r\n');
    final client = HttpClient();
    try {
      final request = await client.postUrl(uri);
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      request.headers.set(HttpHeaders.contentTypeHeader, 'multipart/form-data; boundary=$boundary');
      if (token.isNotEmpty) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      request.add(builder.takeBytes());
      final response = await request.close();
      final text = await utf8.decodeStream(response);
      if (response.statusCode == 401) throw ApiException(401, _errorMessage(text) ?? '凭证无效');
      if (response.statusCode >= 400) throw ApiException(response.statusCode, _errorMessage(text) ?? '请求失败');
      return _decodeObject(text);
    } on ApiException {
      rethrow;
    } on SocketException {
      throw ApiException(0, '无法连接服务器');
    } finally {
      client.close();
    }
  }

  Future<_HttpResult> _send(
    String method,
    Uri uri, {
    required String token,
    Map<String, Object?>? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (token.isNotEmpty) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      }
      if (body != null) {
        request.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
        request.add(utf8.encode(jsonEncode(body)));
      }
      final response = await request.close();
      final text = await utf8.decodeStream(response);
      if (response.statusCode == 401) {
        throw ApiException(401, _errorMessage(text) ?? '凭证无效');
      }
      if (response.statusCode >= 400) {
        throw ApiException(response.statusCode, _errorMessage(text) ?? '请求失败');
      }
      return _HttpResult(response.statusCode, text);
    } on ApiException {
      rethrow;
    } on SocketException {
      throw ApiException(0, '无法连接服务器');
    } finally {
      client.close();
    }
  }

  /// 和 `_send` 走同一套请求构造，区别只在**不把 4xx/5xx 变成异常**。
  Future<_HttpResult> _sendAllowError(
    String method,
    Uri uri, {
    required String token,
    Map<String, Object?>? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      request.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (token.isNotEmpty) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      }
      if (body != null) {
        request.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
        request.add(utf8.encode(jsonEncode(body)));
      }
      final response = await request.close();
      final text = await utf8.decodeStream(response);
      if (response.statusCode == 401) {
        throw ApiException(401, _errorMessage(text) ?? '凭证无效');
      }
      return _HttpResult(response.statusCode, text);
    } on ApiException {
      rethrow;
    } on SocketException {
      throw ApiException(0, '无法连接服务器');
    } finally {
      client.close();
    }
  }

  Map<String, Object?> _decodeObject(String text) {    if (text.isEmpty) return {};
    final decoded = jsonDecode(text);
    if (decoded is Map<String, Object?>) return decoded;
    if (decoded is Map) return Map<String, Object?>.from(decoded);
    return {};
  }
}

class _HttpResult {
  _HttpResult(this.statusCode, this.body);
  final int statusCode;
  final String body;
}

/// 不抛异常的一次请求结果：状态码 + 已解析的 JSON 体。
class ApiResult {
  ApiResult(this.statusCode, this.body);

  final int statusCode;
  final Map<String, Object?> body;

  bool get ok => statusCode < 400;

  /// 服务端的整体错误文案（`{"error": "..."}`）。
  String? get error {
    final value = body['error'];
    return value is String && value.isNotEmpty ? value : null;
  }
}

String? _errorMessage(String text) {
  try {
    final decoded = jsonDecode(text);
    if (decoded is Map && decoded['error'] is String) return decoded['error'] as String;
  } catch (_) {}
  return null;
}

Uri apiUri(String baseUrl, String path, [Map<String, String>? query]) {
  final base = Uri.parse(normalizeBaseUrl(baseUrl));
  return base.replace(
    path: _joinPath(base.path, path),
    queryParameters: query,
  );
}

String normalizeBaseUrl(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) return trimmed;
  final withScheme = trimmed.contains('://') ? trimmed : 'http://$trimmed';
  return withScheme.endsWith('/') ? withScheme.substring(0, withScheme.length - 1) : withScheme;
}

Uri webSocketUri(String baseUrl) {
  final base = Uri.parse(normalizeBaseUrl(baseUrl));
  final scheme = base.scheme == 'https' ? 'wss' : 'ws';
  return Uri(
    scheme: scheme,
    host: base.host,
    port: base.hasPort ? base.port : null,
    path: '/ws',
  );
}

String _joinPath(String basePath, String path) {
  final left = basePath.endsWith('/') ? basePath.substring(0, basePath.length - 1) : basePath;
  final right = path.startsWith('/') ? path : '/$path';
  if (left.isEmpty || left == '/') return right;
  return '$left$right';
}
