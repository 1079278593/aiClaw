import 'package:aiclaw_mobile/src/reflection_body.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('hides the audio marker and keeps the transcript', () {
    const body = '前面\n'
        ':::aiclaw-audio[id=20261029T034355Z_dc src="./tmp.assets/20261029T034355Z_dc.m4a"]\n'
        '\n'
        ':::\n'
        '后面';
    final pieces = splitReflectionBody(body);
    expect(pieces.map((piece) => piece.kind).toList(), ['text', 'audio', 'text']);
    expect(pieces[1].id, '20261029T034355Z_dc');
    expect(pieces[1].src, './tmp.assets/20261029T034355Z_dc.m4a');
    expect(pieces[1].transcript, isEmpty);
    expect(composeReflectionBody(pieces), body);
    expect(audioRecordedLabel('20261029T034355Z_dc'), isNotEmpty);
    expect(formatAudioLength(const Duration(seconds: 4)), '0:04');
    expect(formatAudioLength(null), '--:--');
  });
}
