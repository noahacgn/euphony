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

test('formatLocalCodexTimestamp formats timestamps in the browser timezone', async () => {
  const { formatLocalCodexTimestamp } = await loadLocalCodexBrowserModule();
  const timestamp = '2026-05-03T10:00:00Z';
  const expected = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(timestamp));

  assert.equal(formatLocalCodexTimestamp(timestamp), expected);
  assert.equal(formatLocalCodexTimestamp(null), 'Unknown time');
  assert.equal(formatLocalCodexTimestamp('not-a-date'), 'Unknown time');
});

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

test('loadLocalCodexBrowserState can force-refresh the project scan', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const calls = [];
  const api = {
    async listCodexProjects(options) {
      calls.push(['projects', options]);
      return {
        projects: [
          {
            id: 'project-a',
            name: 'project-a',
            path: null,
            sessionCount: 1
          }
        ],
        warnings: []
      };
    },
    async listCodexProjectSessions(projectId) {
      calls.push(['sessions', projectId]);
      return {
        sessions: [],
        warnings: []
      };
    }
  };

  await loadLocalCodexBrowserState(api, null, null, true);

  assert.deepEqual(calls, [
    ['projects', { refresh: true }],
    ['sessions', 'project-a']
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

test('loadLocalCodexBrowserState keeps the requested session when refresh still returns it', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const api = {
    async listCodexProjects() {
      return {
        projects: [
          {
            id: 'project-a',
            name: 'project-a',
            path: null,
            sessionCount: 2
          }
        ],
        warnings: []
      };
    },
    async listCodexProjectSessions(projectId) {
      return {
        sessions: [
          {
            id: 'session-1',
            title: 'First session',
            preview: 'First preview',
            cwd: null,
            projectId,
            projectName: 'project-a',
            rolloutPath: 'rollout-session-1.jsonl',
            createdAt: null,
            updatedAt: null,
            archived: false
          },
          {
            id: 'session-2',
            title: 'Second session',
            preview: 'Second preview',
            cwd: null,
            projectId,
            projectName: 'project-a',
            rolloutPath: 'rollout-session-2.jsonl',
            createdAt: null,
            updatedAt: null,
            archived: false
          }
        ],
        warnings: []
      };
    }
  };

  const state = await loadLocalCodexBrowserState(api, 'project-a', 'session-2');

  assert.equal(state.selectedSessionId, 'session-2');
});

test('buildLocalCodexSessionTree groups subagents under their direct parent', async () => {
  const { buildLocalCodexSessionTree, getVisibleLocalCodexSessionIds } =
    await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'parent-session',
      title: 'Parent session',
      preview: 'Parent preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'rollout-parent.jsonl',
      createdAt: '2026-05-03T10:00:00Z',
      updatedAt: '2026-05-03T10:01:00Z',
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'child-session',
      title: 'Child session',
      preview: 'Child preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'rollout-child.jsonl',
      createdAt: '2026-05-03T10:02:00Z',
      updatedAt: '2026-05-03T10:03:00Z',
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'parent-session',
      agentNickname: 'Carson'
    }
  ];

  const tree = buildLocalCodexSessionTree(sessions);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].session.id, 'parent-session');
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].id, 'child-session');
  assert.equal(tree[0].isOrphanSubagent, false);
  assert.deepEqual(getVisibleLocalCodexSessionIds(tree, new Set()), [
    'parent-session'
  ]);
  assert.deepEqual(
    getVisibleLocalCodexSessionIds(tree, new Set(['parent-session'])),
    ['parent-session', 'child-session']
  );
});

test('buildLocalCodexSessionTree sorts parent groups by child activity', async () => {
  const { buildLocalCodexSessionTree } = await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'older-parent',
      title: 'Older parent',
      preview: '',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'older-parent.jsonl',
      createdAt: '2026-05-03T10:00:00Z',
      updatedAt: '2026-05-03T10:00:00Z',
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'recent-child',
      title: 'Recent child',
      preview: '',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'recent-child.jsonl',
      createdAt: '2026-05-03T11:00:00Z',
      updatedAt: '2026-05-03T11:00:00Z',
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'older-parent',
      agentNickname: 'Carson'
    },
    {
      id: 'middle-parent',
      title: 'Middle parent',
      preview: '',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'middle-parent.jsonl',
      createdAt: '2026-05-03T10:30:00Z',
      updatedAt: '2026-05-03T10:30:00Z',
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    }
  ];

  const tree = buildLocalCodexSessionTree(sessions);

  assert.deepEqual(
    tree.map(item => item.session.id),
    ['older-parent', 'middle-parent']
  );
});

test('buildLocalCodexSessionTree keeps orphan subagents as top-level rows', async () => {
  const { buildLocalCodexSessionTree } = await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'orphan-child',
      title: 'Orphan child',
      preview: '',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'orphan-child.jsonl',
      createdAt: '2026-05-03T10:00:00Z',
      updatedAt: '2026-05-03T10:00:00Z',
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'missing-parent',
      agentNickname: 'Carson'
    }
  ];

  const tree = buildLocalCodexSessionTree(sessions);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].session.id, 'orphan-child');
  assert.equal(tree[0].isOrphanSubagent, true);
});

test('filterLocalCodexSessionTree returns the full tree for an empty query', async () => {
  const { buildLocalCodexSessionTree, filterLocalCodexSessionTree } =
    await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'parent-session',
      title: 'Investigate search plan',
      preview: 'Build left rail filter',
      cwd: 'D:/IdeaProjects/euphony',
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'parent.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'child-session',
      title: 'Subagent UI audit',
      preview: 'Checks button spacing',
      cwd: 'D:/IdeaProjects/euphony',
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'child.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'parent-session',
      agentNickname: 'Aurora'
    }
  ];
  const tree = buildLocalCodexSessionTree(sessions);

  const result = filterLocalCodexSessionTree(tree, '   ');

  assert.deepEqual(
    result.treeItems.map(item => item.session.id),
    ['parent-session']
  );
  assert.deepEqual(
    result.treeItems[0].children.map(child => child.id),
    ['child-session']
  );
  assert.deepEqual([...result.matchedSessionIds], []);
  assert.deepEqual([...result.autoExpandedParentSessionIds], []);
});

test('filterLocalCodexSessionTree matches summary fields case-insensitively', async () => {
  const { buildLocalCodexSessionTree, filterLocalCodexSessionTree } =
    await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'parent-session',
      title: 'Investigate search plan',
      preview: 'Build left rail filter',
      cwd: 'D:/IdeaProjects/euphony',
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'parent.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'child-session',
      title: 'Subagent UI audit',
      preview: 'Checks button spacing',
      cwd: 'D:/IdeaProjects/euphony',
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'child.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'parent-session',
      agentNickname: 'Aurora'
    },
    {
      id: 'report-123',
      title: 'Release notes',
      preview: 'Summarize app changes',
      cwd: 'D:/Clients/billing',
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'report.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    }
  ];
  const tree = buildLocalCodexSessionTree(sessions);

  assert.deepEqual(
    [...filterLocalCodexSessionTree(tree, 'INVESTIGATE').matchedSessionIds],
    ['parent-session']
  );
  assert.deepEqual(
    [...filterLocalCodexSessionTree(tree, 'button spacing').matchedSessionIds],
    ['child-session']
  );
  assert.deepEqual(
    [...filterLocalCodexSessionTree(tree, 'clients/billing').matchedSessionIds],
    ['report-123']
  );
  assert.deepEqual(
    [...filterLocalCodexSessionTree(tree, 'aurora').matchedSessionIds],
    ['child-session']
  );
  assert.deepEqual(
    [...filterLocalCodexSessionTree(tree, 'REPORT-123').matchedSessionIds],
    ['report-123']
  );
});

test('filterLocalCodexSessionTree keeps matching children visible with parent context', async () => {
  const { buildLocalCodexSessionTree, filterLocalCodexSessionTree } =
    await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'parent-session',
      title: 'Parent session',
      preview: 'Parent preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'parent.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'matching-child',
      title: 'Needle child',
      preview: 'Specific child preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'matching-child.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'parent-session',
      agentNickname: 'Carson'
    },
    {
      id: 'hidden-child',
      title: 'Hidden child',
      preview: 'Unmatched child preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'hidden-child.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'parent-session',
      agentNickname: 'Drew'
    }
  ];
  const tree = buildLocalCodexSessionTree(sessions);

  const result = filterLocalCodexSessionTree(tree, 'needle');

  assert.deepEqual(
    result.treeItems.map(item => item.session.id),
    ['parent-session']
  );
  assert.deepEqual(
    result.treeItems[0].children.map(child => child.id),
    ['matching-child']
  );
  assert.deepEqual([...result.matchedSessionIds], ['matching-child']);
  assert.deepEqual(
    [...result.autoExpandedParentSessionIds],
    ['parent-session']
  );
});

test('filterLocalCodexSessionTree does not include unmatched children when the parent matches', async () => {
  const { buildLocalCodexSessionTree, filterLocalCodexSessionTree } =
    await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'matching-parent',
      title: 'Needle parent',
      preview: 'Parent preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'parent.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'unmatched-child',
      title: 'Child session',
      preview: 'Child preview',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'child.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'matching-parent',
      agentNickname: 'Carson'
    }
  ];
  const tree = buildLocalCodexSessionTree(sessions);

  const result = filterLocalCodexSessionTree(tree, 'needle');

  assert.deepEqual(
    result.treeItems.map(item => item.session.id),
    ['matching-parent']
  );
  assert.deepEqual(result.treeItems[0].children, []);
  assert.deepEqual([...result.matchedSessionIds], ['matching-parent']);
  assert.deepEqual([...result.autoExpandedParentSessionIds], []);
});

test('filterVisibleLocalCodexSessionSelection drops hidden collapsed child rows', async () => {
  const {
    buildLocalCodexSessionTree,
    filterVisibleLocalCodexSessionSelection
  } = await loadLocalCodexBrowserModule();
  const sessions = [
    {
      id: 'parent-session',
      title: 'Parent session',
      preview: '',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'parent.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: null,
      parentSessionId: null,
      agentNickname: null
    },
    {
      id: 'child-session',
      title: 'Child session',
      preview: '',
      cwd: null,
      projectId: 'project-a',
      projectName: 'project-a',
      rolloutPath: 'child.jsonl',
      createdAt: null,
      updatedAt: null,
      archived: false,
      threadSource: 'subagent',
      parentSessionId: 'parent-session',
      agentNickname: 'Carson'
    }
  ];
  const tree = buildLocalCodexSessionTree(sessions);
  const selected = new Set(['parent-session', 'child-session']);

  assert.deepEqual(
    [...filterVisibleLocalCodexSessionSelection(selected, tree, new Set())],
    ['parent-session']
  );
  assert.deepEqual(
    [
      ...filterVisibleLocalCodexSessionSelection(
        selected,
        tree,
        new Set(['parent-session'])
      )
    ],
    ['parent-session', 'child-session']
  );
});

test('loadLocalCodexBrowserState clears the requested session when refresh no longer returns it', async () => {
  const { loadLocalCodexBrowserState } = await loadLocalCodexBrowserModule();
  const api = {
    async listCodexProjects() {
      return {
        projects: [
          {
            id: 'project-a',
            name: 'project-a',
            path: null,
            sessionCount: 1
          }
        ],
        warnings: []
      };
    },
    async listCodexProjectSessions(projectId) {
      return {
        sessions: [
          {
            id: 'session-1',
            title: 'First session',
            preview: 'First preview',
            cwd: null,
            projectId,
            projectName: 'project-a',
            rolloutPath: 'rollout-session-1.jsonl',
            createdAt: null,
            updatedAt: null,
            archived: false
          }
        ],
        warnings: []
      };
    }
  };

  const state = await loadLocalCodexBrowserState(
    api,
    'project-a',
    'missing-session'
  );

  assert.equal(state.selectedSessionId, null);
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

test('loadLocalCodexProjectSessionsState switches projects without reloading project summaries', async () => {
  const { loadLocalCodexProjectSessionsState } =
    await loadLocalCodexBrowserModule();
  const calls = [];
  const api = {
    async listCodexProjects() {
      calls.push(['projects']);
      throw new Error('projects should not be reloaded during project switch');
    },
    async listCodexProjectSessions(projectId) {
      calls.push(['sessions', projectId]);
      return {
        sessions: [
          {
            id: 'session-2',
            title: 'Second session',
            preview: 'Second preview',
            cwd: null,
            projectId,
            projectName: 'project-b',
            rolloutPath: 'rollout-session-2.jsonl',
            createdAt: null,
            updatedAt: null,
            archived: false
          }
        ],
        warnings: ['session warning']
      };
    }
  };

  const state = await loadLocalCodexProjectSessionsState(api, 'project-b', [
    'project warning'
  ]);

  assert.equal(state.selectedProjectId, 'project-b');
  assert.equal(state.selectedSessionId, null);
  assert.equal(state.sessions.length, 1);
  assert.deepEqual(state.warnings, ['project warning', 'session warning']);
  assert.equal(state.errorMessage, '');
  assert.deepEqual(calls, [['sessions', 'project-b']]);
});

test('loadLocalCodexProjectSessionsState keeps project warnings when sessions fail', async () => {
  const { loadLocalCodexProjectSessionsState } =
    await loadLocalCodexBrowserModule();
  const api = {
    async listCodexProjectSessions() {
      throw new Error('HTTP error! status: 500');
    }
  };

  const state = await loadLocalCodexProjectSessionsState(api, 'project-b', [
    'project warning'
  ]);

  assert.deepEqual(state.sessions, []);
  assert.equal(state.selectedProjectId, 'project-b');
  assert.deepEqual(state.warnings, ['project warning']);
  assert.match(state.errorMessage, /Failed to load Codex sessions for project/);
  assert.match(state.errorMessage, /project-b/);
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

test('loadLocalCodexSessionDetail reads only the selected session id', async () => {
  const { loadLocalCodexSessionDetail } = await loadLocalCodexBrowserModule();
  const calls = [];
  const events = [
    {
      type: 'session_meta',
      payload: {
        id: 'session-2'
      }
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Open the selected session'
      }
    }
  ];
  const api = {
    async readCodexSession(sessionId) {
      calls.push(sessionId);
      return events;
    }
  };
  const session = {
    id: 'session-2',
    title: 'Second session',
    preview: 'Second preview',
    cwd: 'D:/IdeaProjects/euphony',
    projectId: 'project-a',
    projectName: 'project-a',
    rolloutPath: 'rollout-session-2.jsonl',
    createdAt: null,
    updatedAt: null,
    archived: false
  };

  const detail = await loadLocalCodexSessionDetail(api, session);

  assert.deepEqual(calls, ['session-2']);
  assert.equal(detail.selectedSessionId, 'session-2');
  assert.deepEqual(detail.sessionData, events);
  assert.equal(detail.errorMessage, '');
});

test('loadLocalCodexSessionDetail returns a visible error state without list data', async () => {
  const { loadLocalCodexSessionDetail } = await loadLocalCodexBrowserModule();
  const api = {
    async readCodexSession() {
      throw new Error('Malformed JSONL at line 4');
    }
  };
  const session = {
    id: 'broken-session',
    title: 'Broken session',
    preview: 'Broken preview',
    cwd: null,
    projectId: 'project-a',
    projectName: 'project-a',
    rolloutPath: 'rollout-broken-session.jsonl',
    createdAt: null,
    updatedAt: null,
    archived: false
  };

  const detail = await loadLocalCodexSessionDetail(api, session);

  assert.equal(detail.selectedSessionId, 'broken-session');
  assert.deepEqual(detail.sessionData, []);
  assert.match(detail.errorMessage, /Failed to load Codex session/);
  assert.match(detail.errorMessage, /Broken session/);
  assert.match(detail.errorMessage, /broken-session/);
  assert.match(detail.errorMessage, /Malformed JSONL at line 4/);
});
