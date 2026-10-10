import 'package:aiclaw_mobile/src/chat_models.dart';
import 'package:aiclaw_mobile/src/session_machine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Map<String, Object?> loaded(String requestId, String sessionId, List<Map<String, Object?>> messages) {
    return {
      'type': 'sessionLoaded',
      'requestId': requestId,
      'session': {'id': sessionId, 'title': sessionId, 'messages': messages},
    };
  }

  test('切换后两边的文本和工具都还在', () {
    final machine = SessionMachine();
    machine.selectSession('A');
    final joinA = machine.sessionLoadRequestId!;
    machine.onServerMessage(loaded(joinA, 'A', []));
    machine.onServerMessage({
      'type': 'chatStart',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 1,
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 2,
      'chunk': 'Hello',
    });

    machine.selectSession('B');
    machine.onServerMessage({
      'type': 'chatStart',
      'sessionId': 'B',
      'runId': 'b1',
      'sequence': 1,
    });
    machine.onServerMessage({
      'type': 'toolCall',
      'sessionId': 'B',
      'runId': 'b1',
      'sequence': 2,
      'name': 'search',
      'input': {'q': 'x'},
      'callId': 'c1',
    });
    machine.onServerMessage({
      'type': 'toolResult',
      'sessionId': 'B',
      'runId': 'b1',
      'sequence': 3,
      'name': 'search',
      'content': 'found',
      'isError': false,
      'callId': 'c1',
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'B',
      'runId': 'b1',
      'sequence': 4,
      'chunk': 'B-text',
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 3,
      'chunk': ' world',
    });
    machine.onServerMessage({
      'type': 'chatEnd',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 4,
      'fullResponse': 'Hello world',
    });
    machine.onServerMessage({
      'type': 'chatEnd',
      'sessionId': 'B',
      'runId': 'b1',
      'sequence': 5,
      'fullResponse': 'B-text',
    });

    machine.selectSession('A');
    expect(machine.runtimeOf('A').messages.single.text, 'Hello world');
    machine.selectSession('B');
    final b = machine.runtimeOf('B').messages.single;
    expect(b.text, 'B-text');
    expect(b.tools.single.name, 'search');
    expect(b.tools.single.result, 'found');
    machine.selectSession('A');
    expect(machine.runtimeOf('A').messages.single.text, 'Hello world');
  });

  test('后台的工具调用、结果和文本按到达顺序回放', () {
    final machine = SessionMachine();
    machine.selectSession('A');
    machine.selectSession('B');
    machine.onServerMessage({
      'type': 'chatStart',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 1,
    });
    machine.onServerMessage({
      'type': 'toolCall',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 2,
      'name': 'read',
      'input': {'path': 'a.md'},
      'callId': 't1',
    });
    machine.onServerMessage({
      'type': 'toolResult',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 3,
      'name': 'read',
      'content': 'body',
      'isError': false,
      'callId': 't1',
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 4,
      'chunk': 'after-tool',
    });

    expect(machine.runtimeOf('A').messages, isEmpty);
    machine.selectSession('A');
    final message = machine.runtimeOf('A').messages.single;
    expect(message.tools.single.name, 'read');
    expect(message.tools.single.result, 'body');
    expect(message.text, 'after-tool');
  });

  test('切走不会自动拒绝权限，切回后仍可确认', () {
    final machine = SessionMachine();
    machine.selectSession('A');
    machine.onServerMessage({
      'type': 'chatStart',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 1,
    });
    machine.onServerMessage({
      'type': 'toolPermissionRequest',
      'sessionId': 'A',
      'runId': 'a1',
      'sequence': 2,
      'requestId': 'R1',
      'toolName': 'write',
      'details': {'path': 'a.md'},
    });
    expect(machine.permissionVisible, isTrue);

    final before = machine.outbound.length;
    machine.selectSession('B');
    expect(machine.permissionVisible, isFalse);
    expect(
      machine.outbound.skip(before).any((event) => event['type'] == 'toolPermissionResponse'),
      isFalse,
    );
    expect(machine.runtimeOf('A').pendingPermission?['requestId'], 'R1');

    machine.selectSession('A');
    expect(machine.permissionVisible, isTrue);
    machine.respondPermission(true);
    expect(machine.outbound.last['type'], 'toolPermissionResponse');
    expect(machine.outbound.last['requestId'], 'R1');
    expect(machine.outbound.last['allowed'], isTrue);
    expect(machine.runtimeOf('A').pendingPermission, isNull);
  });

  test('取消后新运行不受旧运行迟到事件影响', () {
    final machine = SessionMachine();
    machine.selectSession('A');
    machine.onServerMessage({
      'type': 'chatStart',
      'sessionId': 'A',
      'runId': 'old',
      'sequence': 1,
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'A',
      'runId': 'old',
      'sequence': 2,
      'chunk': 'old',
    });
    machine.cancelCurrent();
    machine.onServerMessage({
      'type': 'chatCancelled',
      'sessionId': 'A',
      'runId': 'old',
      'sequence': 3,
      'fullResponse': 'old',
    });
    machine.onServerMessage({
      'type': 'chatStart',
      'sessionId': 'A',
      'runId': 'new',
      'sequence': 1,
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'A',
      'runId': 'old',
      'sequence': 9,
      'chunk': 'LATE',
    });
    machine.onServerMessage({
      'type': 'chatChunk',
      'sessionId': 'A',
      'runId': 'new',
      'sequence': 2,
      'chunk': 'fresh',
    });

    final messages = machine.runtimeOf('A').messages;
    expect(messages, hasLength(2));
    expect(messages.first.text, 'old');
    expect(messages.last.text, 'fresh');
  });

  test('过期的 sessionLoaded 不覆盖最新会话', () {
    final machine = SessionMachine();
    machine.selectSession('A');
    final first = machine.sessionLoadRequestId!;
    machine.onServerMessage(loaded(first, 'A', [
      {'id': '1', 'role': 'user', 'content': 'keep'},
    ]));
    machine.selectSession('B');
    machine.selectSession('A');
    final latest = machine.sessionLoadRequestId!;
    expect(latest, isNot(first));

    machine.onServerMessage(loaded(first, 'A', [
      {'id': '1', 'role': 'user', 'content': 'keep'},
      {'id': '2', 'role': 'user', 'content': 'stale'},
    ]));
    expect(machine.runtimeOf('A').messages.single.text, 'keep');

    machine.onServerMessage(loaded(latest, 'A', [
      {'id': '1', 'role': 'user', 'content': 'keep'},
      {'id': '3', 'role': 'user', 'content': 'fresh'},
    ]));
    expect(machine.runtimeOf('A').messages.map((message) => message.text), ['keep', 'fresh']);
  });

  test('尚未落盘的本地用户消息不会被同一次 join 的快照清掉', () {
    final machine = SessionMachine();
    machine.selectSession('A');
    final requestId = machine.sessionLoadRequestId!;
    machine.onServerMessage(loaded(requestId, 'A', [
      {'id': '1', 'role': 'user', 'content': 'keep'},
    ]));
    machine.runtimeOf('A').messages.add(DisplayMessage(
      id: 'local-1',
      role: 'user',
      text: 'just-sent',
    ));
    machine.onServerMessage(loaded(requestId, 'A', [
      {'id': '1', 'role': 'user', 'content': 'keep'},
    ]));
    expect(
      machine.runtimeOf('A').messages.map((message) => message.text),
      ['keep', 'just-sent'],
    );
  });
}
