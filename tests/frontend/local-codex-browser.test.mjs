import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

async function loadLocalCodexBrowserModule() {
  const sourcePath = join(
    process.cwd(),
    'src',
    'components',
    'app',
    'local-codex-browser.ts'
  );
  const tempDir = await mkdtemp(join(tmpdir(), 'euphony-local-codex-browser-'));
  const outputPath = join(tempDir, 'local-codex-browser.mjs');
  const source = await readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  });
  await writeFile(outputPath, output.outputText, 'utf8');
  try {
    const moduleURL = pathToFileURL(outputPath);
    moduleURL.searchParams.set('t', Date.now().toString());
    return await import(moduleURL.href);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

test('loadLocalCodexBrowserState selects the first project and loads only summaries', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const calls = [];
  const api = {
    async listCodexProjects() {
      calls.push(['projects']);
      return {
        projects: [
          {
            id: 'D:/IdeaProjects/euphony',
            name: 'euphony',
            path: 'D:/IdeaProjects/euphony',
            sessionCount: 2
          },
          {
            id: 'D:/IdeaProjects/other',
            name: 'other',
            path: 'D:/IdeaProjects/other',
            sessionCount: 1
          }
        ],
        warnings: ['bad rollout skipped']
      };
    },
    async listCodexProjectSessions(projectId) {
      calls.push(['sessions', projectId]);
      return {
        sessions: [
          {
            id: 'session-1',
            title: 'Browse Codex sessions',
            preview: 'List sessions',
            cwd: 'D:/IdeaProjects/euphony',
            projectId,
            projectName: 'euphony',
            rolloutPath: 'D:/codex/rollout-session-1.jsonl',
            createdAt: '2026-05-03T10:00:00Z',
            updatedAt: '2026-05-03T10:01:00Z',
            archived: false
          }
        ],
        warnings: ['session warning']
      };
    },
    async readCodexSession() {
      calls.push(['detail']);
      throw new Error('detail should not be read by summary browser');
    }
  };

  const state = await loadLocalCodexBrowserState(api);

  assert.equal(state.selectedProjectId, 'D:/IdeaProjects/euphony');
  assert.equal(state.projects.length, 2);
  assert.equal(state.sessions.length, 1);
  assert.deepEqual(state.warnings, ['bad rollout skipped', 'session warning']);
  assert.equal(state.errorMessage, '');
  assert.deepEqual(calls, [
    ['projects'],
    ['sessions', 'D:/IdeaProjects/euphony']
  ]);
});

test('loadLocalCodexBrowserState keeps the requested project when it still exists', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const calls = [];
  const api = {
    async listCodexProjects() {
      return {
        projects: [
          {
            id: 'project-a',
            name: 'project-a',
            path: null,
            sessionCount: 1
          },
          {
            id: 'project-b',
            name: 'project-b',
            path: null,
            sessionCount: 3
          }
        ],
        warnings: []
      };
    },
    async listCodexProjectSessions(projectId) {
      calls.push(projectId);
      return {
        sessions: [],
        warnings: []
      };
    }
  };

  const state = await loadLocalCodexBrowserState(api, 'project-b');

  assert.equal(state.selectedProjectId, 'project-b');
  assert.deepEqual(calls, ['project-b']);
});

test('loadLocalCodexBrowserState returns an empty state when no projects exist', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const api = {
    async listCodexProjects() {
      return {
        projects: [],
        warnings: ['codex home empty']
      };
    },
    async listCodexProjectSessions() {
      throw new Error('sessions should not be loaded without a project');
    }
  };

  const state = await loadLocalCodexBrowserState(api);

  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.warnings, ['codex home empty']);
  assert.equal(state.selectedProjectId, null);
  assert.equal(state.errorMessage, '');
});

test('loadLocalCodexBrowserState surfaces backend failures as a clear error state', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const api = {
    async listCodexProjects() {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8020');
    },
    async listCodexProjectSessions() {
      throw new Error('sessions should not be loaded after project failure');
    }
  };

  const state = await loadLocalCodexBrowserState(api);

  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.sessions, []);
  assert.equal(state.selectedProjectId, null);
  assert.match(state.errorMessage, /Failed to load local Codex sessions/);
  assert.match(state.errorMessage, /Start the local FastAPI backend/);
  assert.match(state.errorMessage, /ECONNREFUSED/);
});
