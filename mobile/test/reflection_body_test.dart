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

  test('reads and writes an optional audio name', () {
    const body = ':::aiclaw-audio[id=20261029T034355Z_dc src="./a.assets/x.m4a" name="散步随想"]\n'
        '草稿\n'
        ':::';
    final pieces = splitReflectionBody(body);
    expect(pieces.first.kind, 'audio');
    expect(pieces.first.name, '散步随想');
    expect(pieces.first.audioTitle, '散步随想');
    expect(
      formatAudioBlock(
        id: '20261029T034355Z_dc',
        src: './a.assets/x.m4a',
        name: '散步随想',
        transcript: '草稿',
      ),
      body,
    );
    expect(
      formatAudioBlock(id: 'i', src: './a.assets/x.m4a', transcript: '字'),
      ':::aiclaw-audio[id=i src="./a.assets/x.m4a"]\n字\n:::',
    );
    expect(ReflectionPiece.audio(raw: '', id: 'i', src: 's', transcript: '').audioTitle, '录音');
  });

  test('reflectionPiecesKey distinguishes single text segments by content', () {
    final a = splitReflectionBody('第一段');
    final b = splitReflectionBody('第二段');
    expect(reflectionPiecesKey(a), isNot(reflectionPiecesKey(b)));
    expect(reflectionPiecesKey(a), reflectionPiecesKey(splitReflectionBody('第一段')));
  });
}
