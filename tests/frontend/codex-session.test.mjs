import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function loadCodexSessionModule() {
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    optimizeDeps: {
      entries: [],
      noDiscovery: true
    },
    server: {
      hmr: false,
      middlewareMode: true
    }
  });
  try {
    return await server.ssrLoadModule('/src/utils/codex-session.ts');
  } finally {
    await server.close();
  }
}

test('会话包含未知事件时仍能解析已有消息', async () => {
  const { parseCodexSession } = await loadCodexSessionModule();
  // 真实会话的最小复现：四条合法记录中只有两条被识别，原先的 60% 门槛会拒绝整段会话。
  // 使用虚构正文保留触发结构，避免将本机会话内容写入测试仓库。
  const events = [
    { type: 'session_meta', payload: { id: 'session-new-events' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '请显示会话正文' }]
      }
    },
    { type: 'token_usage_record', payload: {} },
    { type: 'event_msg', payload: { type: 'item_completed' } }
  ];

  // 本地会话 API 提供对象数组；外部 JSONL 加载也可能提供逐行字符串，两者都走真实解析入口。
  for (const input of [events, events.map(event => JSON.stringify(event))]) {
    const result = parseCodexSession(input);

    assert.ok(result, '合法 Codex 会话不应显示格式错误');
    assert.equal(result.conversation.id, 'session-new-events');
    const userMessages = result.conversation.messages.filter(
      message => message.role === 'user'
    );
    assert.deepEqual(
      userMessages.map(message => message.content),
      [[{ text: '请显示会话正文' }]]
    );
  }
});

test('缺少会话标记时仍区分消息片段与普通 JSONL', async () => {
  const { isCodexSessionJSONL, parseCodexSession } =
    await loadCodexSessionModule();
  const message = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '会话片段' }]
    }
  };
  // 无 session_meta 的数据继续依赖原有启发式，避免普通 JSONL 偶含一条消息就被误判。
  const ordinaryJSONL = [message, { project: 'euphony' }, { status: 'ready' }];

  assert.equal(isCodexSessionJSONL([message]), true);
  assert.ok(parseCodexSession([message]));
  assert.equal(isCodexSessionJSONL(ordinaryJSONL), false);
  assert.equal(parseCodexSession(ordinaryJSONL), null);
  assert.equal(isCodexSessionJSONL([]), false);
});
