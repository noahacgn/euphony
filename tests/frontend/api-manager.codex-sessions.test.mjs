import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

async function loadAPIManagerModule({ apiURL } = {}) {
  const environmentVariableName = 'VITE_EUPHONY_API_URL';
  const previousAPIURL = process.env[environmentVariableName];

  // 每个测试显式控制 Vite 环境，避免开发者终端中的同名变量污染默认值断言。
  if (apiURL === undefined) {
    delete process.env[environmentVariableName];
  } else {
    process.env[environmentVariableName] = apiURL;
  }

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
    return await server.ssrLoadModule('/src/utils/api-manager.ts');
  } finally {
    await server.close();
    if (previousAPIURL === undefined) {
      delete process.env[environmentVariableName];
    } else {
      process.env[environmentVariableName] = previousAPIURL;
    }
  }
}

test('development API URL honors the backend URL supplied by the launcher', async () => {
  const { EUPHONY_API_URL } = await loadAPIManagerModule({
    apiURL: 'http://127.0.0.1:18021/'
  });

  assert.equal(EUPHONY_API_URL, 'http://127.0.0.1:18021/');
});

test('development API URL defaults to the local backend port', async () => {
  const { EUPHONY_API_URL } = await loadAPIManagerModule();

  assert.equal(EUPHONY_API_URL, 'http://localhost:18020/');
});

test('APIManager reads local Codex projects, sessions, and detail through backend APIs', async () => {
  const { APIManager } = await loadAPIManagerModule();
  const requestedURLs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    requestedURLs.push(String(input));
    const url = String(input);
    if (url.endsWith('/codex-sessions/projects/')) {
      return Response.json({
        projects: [
          {
            id: 'D:/IdeaProjects/euphony',
            name: 'euphony',
            path: 'D:/IdeaProjects/euphony',
            sessionCount: 2
          }
        ],
        warnings: ['bad rollout skipped']
      });
    }
    if (
      url.endsWith(
        '/codex-sessions/sessions/?projectId=D%3A%2FIdeaProjects%2Feuphony'
      )
    ) {
      return Response.json({
        sessions: [
          {
            id: 'session-1',
            title: 'Browse Codex sessions',
            preview: 'List sessions',
            cwd: 'D:/IdeaProjects/euphony',
            projectId: 'D:/IdeaProjects/euphony',
            projectName: 'euphony',
            rolloutPath: 'D:/codex/rollout-session-1.jsonl',
            createdAt: '2026-05-03T10:00:00Z',
            updatedAt: '2026-05-03T10:01:00Z',
            archived: false,
            threadSource: 'subagent',
            parentSessionId: 'parent-session',
            agentNickname: 'Carson'
          }
        ],
        warnings: []
      });
    }
    if (url.endsWith('/codex-sessions/sessions/session-1/')) {
      return Response.json([
        {
          type: 'session_meta',
          payload: {
            id: 'session-1'
          }
        }
      ]);
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const manager = new APIManager('http://localhost:8020/');

    assert.deepEqual(await manager.listCodexProjects(), {
      projects: [
        {
          id: 'D:/IdeaProjects/euphony',
          name: 'euphony',
          path: 'D:/IdeaProjects/euphony',
          sessionCount: 2
        }
      ],
      warnings: ['bad rollout skipped']
    });

    assert.deepEqual(
      await manager.listCodexProjectSessions('D:/IdeaProjects/euphony'),
      {
        sessions: [
          {
            id: 'session-1',
            title: 'Browse Codex sessions',
            preview: 'List sessions',
            cwd: 'D:/IdeaProjects/euphony',
            projectId: 'D:/IdeaProjects/euphony',
            projectName: 'euphony',
            rolloutPath: 'D:/codex/rollout-session-1.jsonl',
            createdAt: '2026-05-03T10:00:00Z',
            updatedAt: '2026-05-03T10:01:00Z',
            archived: false,
            threadSource: 'subagent',
            parentSessionId: 'parent-session',
            agentNickname: 'Carson'
          }
        ],
        warnings: []
      }
    );

    assert.deepEqual(await manager.readCodexSession('session-1'), [
      {
        type: 'session_meta',
        payload: {
          id: 'session-1'
        }
      }
    ]);
    assert.deepEqual(requestedURLs, [
      'http://localhost:8020/codex-sessions/projects/',
      'http://localhost:8020/codex-sessions/sessions/?projectId=D%3A%2FIdeaProjects%2Feuphony',
      'http://localhost:8020/codex-sessions/sessions/session-1/'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('APIManager deletes local Codex sessions through backend APIs', async () => {
  const { APIManager } = await loadAPIManagerModule();
  const requestedRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestedRequests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
      headers: init?.headers ?? null
    });

    const url = String(input);
    if (
      url.endsWith('/codex-sessions/sessions/') &&
      init?.method === 'DELETE'
    ) {
      return Response.json({
        deletedSessionIds: ['session-1', 'session-2']
      });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const manager = new APIManager('http://localhost:8020/');

    await manager.deleteCodexSessions(['session-1', 'session-2']);

    assert.deepEqual(requestedRequests, [
      {
        url: 'http://localhost:8020/codex-sessions/sessions/',
        method: 'DELETE',
        body: JSON.stringify({ sessionIds: ['session-1', 'session-2'] }),
        headers: {
          'Content-Type': 'application/json'
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('APIManager sends refresh=true only for explicit local Codex refreshes', async () => {
  const { APIManager } = await loadAPIManagerModule();
  const requestedURLs = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    requestedURLs.push(String(input));
    return Response.json({
      projects: [],
      warnings: []
    });
  };

  try {
    const manager = new APIManager('http://localhost:8020/');

    await manager.listCodexProjects();
    await manager.listCodexProjects({ refresh: true });

    assert.deepEqual(requestedURLs, [
      'http://localhost:8020/codex-sessions/projects/',
      'http://localhost:8020/codex-sessions/projects/?refresh=true'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('BrowserAPIManager does not expose local Codex session APIs', async () => {
  const { BrowserAPIManager } = await loadAPIManagerModule();
  const manager = new BrowserAPIManager();

  assert.equal(manager.listCodexProjects, undefined);
  assert.equal(manager.listCodexProjectSessions, undefined);
  assert.equal(manager.readCodexSession, undefined);
  assert.equal(manager.deleteCodexSessions, undefined);
});

test('BrowserAPIManager loads the Harmony tokenizer only when rendering is requested', async () => {
  const apiManagerSource = await readFile(
    join(process.cwd(), 'src/utils/api-manager.ts'),
    'utf-8'
  );

  assert.doesNotMatch(apiManagerSource, /from '\.\/harmony-render'/);
  assert.match(apiManagerSource, /import\(\s*'\.\/harmony-render'\s*\)/);
});
