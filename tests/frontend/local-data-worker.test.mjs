import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function loadLocalDataWorkerModule() {
  const originalSelf = globalThis.self;
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

  globalThis.self = {};
  try {
    return await server.ssrLoadModule('/src/components/app/local-data-worker.ts');
  } finally {
    globalThis.self = originalSelf;
    await server.close();
  }
}

test('parseLocalData keeps legacy JSON conversation files loadable', async () => {
  const { parseLocalData } = await loadLocalDataWorkerModule();

  const result = parseLocalData(
    JSON.stringify({
      id: 'conversation-1',
      messages: []
    })
  );

  assert.equal(result.dataType, 'conversation');
  assert.equal(result.conversationData.length, 1);
  assert.equal(result.conversationData[0].id, 'conversation-1');
});

test('parseLocalData keeps legacy JSONL conversation files loadable', async () => {
  const { parseLocalData } = await loadLocalDataWorkerModule();

  const result = parseLocalData(
    [
      JSON.stringify({
        id: 'conversation-1',
        messages: []
      }),
      JSON.stringify({
        id: 'conversation-2',
        messages: []
      })
    ].join('\n')
  );

  assert.equal(result.dataType, 'conversation');
  assert.deepEqual(
    result.conversationData.map(conversation => conversation.id),
    ['conversation-1', 'conversation-2']
  );
});

test('parseLocalData routes manually uploaded Codex JSONL to the Codex renderer data path', async () => {
  const { parseLocalData } = await loadLocalDataWorkerModule();
  const codexJSONL = [
    JSON.stringify({
      timestamp: '2026-05-03T10:00:00Z',
      type: 'session_meta',
      payload: {
        id: 'session-1',
        cwd: 'D:/IdeaProjects/euphony'
      }
    }),
    JSON.stringify({
      timestamp: '2026-05-03T10:01:00Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Render this manually uploaded session'
      }
    })
  ].join('\n');

  const result = parseLocalData(codexJSONL);

  assert.equal(result.dataType, 'codex');
  assert.equal(result.codexSessionData.length, 2);
});

test('parseLocalData falls back to JSON viewer data for non-conversation JSON', async () => {
  const { parseLocalData } = await loadLocalDataWorkerModule();

  const result = parseLocalData(
    JSON.stringify({
      project: 'euphony',
      sessionCount: 2
    })
  );

  assert.equal(result.dataType, 'json');
  assert.deepEqual(result.jsonData, [
    {
      project: 'euphony',
      sessionCount: 2
    }
  ]);
});
