/// 心得正文的存储标记与编辑器片段。标记留在文件里，界面按片段画，不把标记原文给用户看。
class ReflectionPiece {
  ReflectionPiece.text(this.text)
      : kind = 'text',
        raw = '',
        id = '',
        src = '',
        transcript = '',
        alt = '';

  ReflectionPiece.audio({
    required this.raw,
    required this.id,
    required this.src,
    required this.transcript,
  })  : kind = 'audio',
        text = '',
        alt = '';

  ReflectionPiece.image({
    required this.raw,
    required this.src,
    required this.alt,
  })  : kind = 'image',
        text = '',
        id = '',
        transcript = '';

  final String kind;
  final String text;
  final String raw;
  final String id;
  final String src;
  final String transcript;
  final String alt;

  ReflectionPiece withText(String value) {
    return ReflectionPiece.text(value);
  }
}

final _piecePattern = RegExp(
  r'^:::aiclaw-audio\[([^\]]*)\]\r?\n([\s\S]*?)^:::[ \t]*$|!\[([^\]]*)\]\(([^)\s]*\.assets/[^)\s]+)\)',
  multiLine: true,
);

/// 按原文顺序拆成文字、语音、图片。末尾若不是文字，补一段空文字，方便在附件后面继续写。
List<ReflectionPiece> splitReflectionBody(String body) {
  final pieces = <ReflectionPiece>[];
  var index = 0;
  for (final match in _piecePattern.allMatches(body)) {
    if (match.start > index) {
      pieces.add(ReflectionPiece.text(body.substring(index, match.start)));
    }
    final raw = match.group(0) ?? '';
    if (raw.startsWith(':::')) {
      final attrs = parseReflectionAttrs(match.group(1) ?? '');
      pieces.add(ReflectionPiece.audio(
        raw: raw,
        id: attrs['id'] ?? '',
        src: attrs['src'] ?? '',
        transcript: (match.group(2) ?? '').trim(),
      ));
    } else {
      pieces.add(ReflectionPiece.image(
        raw: raw,
        src: match.group(4) ?? '',
        alt: match.group(3) ?? '',
      ));
    }
    index = match.end;
  }
  if (index < body.length) {
    pieces.add(ReflectionPiece.text(body.substring(index)));
  }
  if (pieces.isEmpty || pieces.last.kind != 'text') {
    pieces.add(ReflectionPiece.text(''));
  }
  return pieces;
}

String composeReflectionBody(List<ReflectionPiece> pieces) {
  return pieces.map((piece) => piece.kind == 'text' ? piece.text : piece.raw).join();
}

Map<String, String> parseReflectionAttrs(String raw) {
  final out = <String, String>{};
  final parts = RegExp(r'(?:[^\s"]+|"[^"]*")+' ).allMatches(raw);
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

/// 标记 id 里的 UTC 时间，显示成本机本地时间。解析不了就返回空字符串。
String audioRecordedLabel(String id) {
  final match = RegExp(r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z').firstMatch(id);
  if (match == null) return '';
  final local = DateTime.utc(
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
    int.parse(match.group(4)!),
    int.parse(match.group(5)!),
    int.parse(match.group(6)!),
  ).toLocal();
  final month = local.month.toString().padLeft(2, '0');
  final day = local.day.toString().padLeft(2, '0');
  final hour = local.hour.toString().padLeft(2, '0');
  final minute = local.minute.toString().padLeft(2, '0');
  return '${local.year}年$month月$day日 $hour:$minute';
}

String formatAudioLength(Duration? duration) {
  if (duration == null) return '--:--';
  final total = duration.inSeconds < 0 ? 0 : duration.inSeconds;
  final seconds = (total % 60).toString().padLeft(2, '0');
  final hours = total ~/ 3600;
  if (hours > 0) {
    final minutes = ((total ~/ 60) % 60).toString().padLeft(2, '0');
    return '$hours:$minutes:$seconds';
  }
  return '${total ~/ 60}:$seconds';
}
