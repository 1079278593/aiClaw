/// 聊天展示模型。字段对齐 mobile/docs/api_shapes.md 第 3 节。
class ToolBlock {
  ToolBlock({
    required this.callId,
    required this.name,
    required this.arguments,
    this.result,
    this.isError = false,
  });

  final String callId;
  final String name;
  final String arguments;
  String? result;
  bool isError;
}

class DisplayMessage {
  DisplayMessage({
    required this.id,
    required this.role,
    this.text = '',
    this.reasoning = '',
    this.runId,
    List<ToolBlock>? tools,
    List<ChatImage>? images,
  })  : tools = tools ?? [],
        images = images ?? [];

  final String id;
  final String role;
  String text;
  String reasoning;
  final String? runId;
  final List<ToolBlock> tools;
  final List<ChatImage> images;
}

class ChatImage {
  const ChatImage({required this.url, this.path});

  final String url;
  final String? path;

  bool get inline =>
      url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://');
}

class ThinkingChoice {
  const ThinkingChoice({required this.id, required this.label});

  final String id;
  final String label;
}

class ModelChoice {
  const ModelChoice({
    required this.id,
    required this.label,
    required this.vision,
    required this.thinking,
  });

  final String id;
  final String label;
  final bool vision;
  final List<ThinkingChoice> thinking;
}

class ServerConfig {
  ServerConfig({
    required this.availableProviders,
    required this.modelsByProvider,
    required this.defaultProvider,
    required this.defaultModel,
    required this.defaultThinkingEffort,
    required this.triliumEnabled,
    required this.authRequired,
  });

  final List<String> availableProviders;
  final Map<String, List<ModelChoice>> modelsByProvider;
  final String defaultProvider;
  final String defaultModel;
  final String defaultThinkingEffort;
  final bool triliumEnabled;
  final bool authRequired;

  List<ModelChoice> modelsFor(String provider) => modelsByProvider[provider] ?? const [];

  ModelChoice? findModel(String provider, String modelId) {
    for (final model in modelsFor(provider)) {
      if (model.id == modelId) return model;
    }
    return null;
  }

  /// 当前 thinking 不在新模型列表中时，用第一项；列表为空则用默认档。
  String alignThinking(String provider, String modelId, String current) {
    final model = findModel(provider, modelId);
    final options = model?.thinking ?? const <ThinkingChoice>[];
    if (options.any((item) => item.id == current)) return current;
    if (options.isNotEmpty) return options.first.id;
    return defaultThinkingEffort;
  }

  factory ServerConfig.fromJson(Map<String, Object?> json) {
    final providers = json['providers'];
    final modelsByProvider = <String, List<ModelChoice>>{};
    if (providers is Map) {
      for (final entry in providers.entries) {
        final body = entry.value;
        if (body is! Map) continue;
        final models = body['models'];
        if (models is! List) continue;
        modelsByProvider['${entry.key}'] = [
          for (final raw in models)
            if (raw is Map) ModelChoice(
              id: '${raw['id'] ?? ''}',
              label: '${raw['label'] ?? raw['id'] ?? ''}',
              vision: raw['modal'] == 'vl',
              thinking: _thinkingOptions(raw),
            ),
        ];
      }
    }
    final available = json['availableProviders'];
    return ServerConfig(
      availableProviders: [
        for (final item in available is List ? available : const []) '$item',
      ],
      modelsByProvider: modelsByProvider,
      defaultProvider: '${json['defaultProvider'] ?? ''}',
      defaultModel: '${json['defaultModel'] ?? ''}',
      defaultThinkingEffort: '${json['defaultThinkingEffort'] ?? ''}',
      triliumEnabled: json['triliumEnabled'] == true,
      authRequired: json['authRequired'] == true,
    );
  }
}

List<ThinkingChoice> _thinkingOptions(Map raw) {
  final options = <ThinkingChoice>[];
  if (raw.containsKey('thinkingOff')) {
    options.add(const ThinkingChoice(id: 'off', label: 'off'));
  }
  final thinking = raw['thinking'];
  if (thinking is List) {
    for (final item in thinking) {
      if (item is! Map) continue;
      final id = '${item['id'] ?? ''}';
      if (id.isEmpty) continue;
      options.add(ThinkingChoice(id: id, label: '${item['label'] ?? id}'));
    }
  }
  return options;
}

List<DisplayMessage> parseHistory(Object? raw) {
  if (raw is! List) return [];
  final messages = <DisplayMessage>[];
  for (final item in raw) {
    if (item is! Map) continue;
    final role = '${item['role'] ?? ''}';
    final id = '${item['id'] ?? ''}';
    if (role == 'system' && id == 'meta') continue;
    if (role == 'tool') {
      final callId = '${item['tool_call_id'] ?? ''}';
      final result = _textOf(item['content']);
      var attached = false;
      for (final message in messages.reversed) {
        for (final tool in message.tools) {
          if (tool.callId == callId) {
            tool.result = result;
            attached = true;
            break;
          }
        }
        if (attached) break;
      }
      if (!attached) {
        messages.add(DisplayMessage(
          id: id.isEmpty ? 'tool-$callId' : id,
          role: 'assistant',
          tools: [
            ToolBlock(callId: callId, name: 'tool', arguments: '', result: result),
          ],
        ));
      }
      continue;
    }
    final tools = <ToolBlock>[];
    final calls = item['tool_calls'];
    if (calls is List) {
      for (final call in calls) {
        if (call is! Map) continue;
        final function = call['function'];
        final name = function is Map ? '${function['name'] ?? ''}' : '';
        final arguments = function is Map ? '${function['arguments'] ?? ''}' : '';
        tools.add(ToolBlock(
          callId: '${call['id'] ?? ''}',
          name: name,
          arguments: arguments,
        ));
      }
    }
    messages.add(DisplayMessage(
      id: id,
      role: role,
      text: _textOf(item['content']),
      reasoning: '${item['reasoning_content'] ?? ''}',
      tools: tools,
      images: _imagesOf(item['content']),
    ));
  }
  return messages;
}

String _textOf(Object? content) {
  if (content == null) return '';
  if (content is String) return content;
  if (content is List) {
    final buffer = StringBuffer();
    for (final part in content) {
      if (part is! Map || part['type'] != 'text') continue;
      if (buffer.isNotEmpty) buffer.writeln();
      buffer.write(part['text'] ?? '');
    }
    return buffer.toString();
  }
  return '';
}

List<ChatImage> _imagesOf(Object? content) {
  if (content is! List) return const [];
  final images = <ChatImage>[];
  for (final part in content) {
    if (part is! Map || part['type'] != 'image_url') continue;
    final image = part['image_url'];
    if (image is! Map) continue;
    images.add(ChatImage(
      url: '${image['url'] ?? ''}',
      path: image['path'] as String?,
    ));
  }
  return images;
}

Map<String, Object?> chatMessagePayload({
  required String sessionId,
  required String content,
  required String provider,
  required String model,
  required String thinkingEffort,
  List<Map<String, String>>? images,
  String? previewPath,
  String? selectedPreviewText,
}) {
  final payload = <String, Object?>{
    'type': 'chatMessage',
    'sessionId': sessionId,
    'content': content,
    'provider': provider,
    'model': model,
    'thinkingEffort': thinkingEffort,
  };
  if (images != null && images.isNotEmpty) payload['images'] = images;
  if (previewPath != null && previewPath.isNotEmpty) payload['previewPath'] = previewPath;
  if (selectedPreviewText != null && selectedPreviewText.isNotEmpty) {
    payload['selectedPreviewText'] = selectedPreviewText;
  }
  return payload;
}
