import type {
  CodexProjectSummary,
  CodexProjectsResponse,
  CodexSessionEvent,
  CodexSessionSummary,
  CodexSessionsResponse
} from '../../types/common-types';
import { Role, type Message } from '../../types/harmony-types';
import { parseCodexSession } from '../../utils/codex-session';

export interface LocalCodexBrowserListAPI {
  listCodexProjects: (options?: {
    refresh?: boolean;
  }) => Promise<CodexProjectsResponse>;
  listCodexProjectSessions: (
    projectId: string
  ) => Promise<CodexSessionsResponse>;
}

export interface LocalCodexSessionDetailAPI {
  readCodexSession: (sessionId: string) => Promise<CodexSessionEvent[]>;
}

export interface LocalCodexBrowserState {
  projects: CodexProjectSummary[];
  sessions: CodexSessionSummary[];
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  projectWarnings: string[];
  sessionWarnings: string[];
  warnings: string[];
  errorMessage: string;
}

export interface LocalCodexProjectSessionsState {
  sessions: CodexSessionSummary[];
  selectedProjectId: string;
  selectedSessionId: string | null;
  sessionWarnings: string[];
  warnings: string[];
  errorMessage: string;
}

export interface LocalCodexSessionDetailState {
  selectedSessionId: string;
  sessionData: CodexSessionEvent[];
  errorMessage: string;
}

export interface LocalCodexSessionTreeItem {
  session: CodexSessionSummary;
  children: CodexSessionSummary[];
  isOrphanSubagent: boolean;
  sortTimestamp: string | null;
}

export interface LocalCodexMessageJumpItem {
  messageIndex: number;
  role: Role.User | Role.Assistant;
  preview: string;
}

export interface FilterLocalCodexSessionTreeResult {
  treeItems: LocalCodexSessionTreeItem[];
  matchedSessionIds: Set<string>;
  autoExpandedParentSessionIds: Set<string>;
}

const LOCAL_CODEX_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const mergeWarnings = (...warningGroups: string[][]): string[] => [
  ...new Set(warningGroups.flat())
];

const MESSAGE_JUMP_PREVIEW_MAX_LENGTH = 96;

const normalizeLocalCodexMessagePreview = (text: string): string =>
  text.replace(/\s+/g, ' ').trim();

const truncateLocalCodexMessagePreview = (text: string): string => {
  if (text.length <= MESSAGE_JUMP_PREVIEW_MAX_LENGTH) {
    return text;
  }

  return `${text
    .slice(0, MESSAGE_JUMP_PREVIEW_MAX_LENGTH - 3)
    .trimEnd()}...`;
};

const getLocalCodexMessagePreview = (message: Message): string => {
  const messageTexts =
    typeof message.content === 'string'
      ? [message.content]
      : message.content.map(content => {
          if ('text' in content) {
            return content.text;
          }
          if (
            'instructions' in content &&
            typeof content.instructions === 'string'
          ) {
            return content.instructions;
          }
          return '';
        });
  const preview =
    messageTexts
      .map(normalizeLocalCodexMessagePreview)
      .find(text => text !== '') ?? '[empty message]';

  return truncateLocalCodexMessagePreview(preview);
};

export const isLocalCodexSubagentSession = (
  session: CodexSessionSummary
): boolean => session.threadSource === 'subagent';

export const buildLocalCodexMessageJumpItems = (
  rawEvents: unknown[]
): LocalCodexMessageJumpItem[] => {
  const parseResult = parseCodexSession(rawEvents);
  if (parseResult === null) {
    return [];
  }

  return parseResult.conversation.messages.flatMap((message, messageIndex) => {
    if (message.role !== Role.User && message.role !== Role.Assistant) {
      return [];
    }
    if (message.role === Role.Assistant && message.channel === 'analysis') {
      return [];
    }

    return [
      {
        messageIndex,
        role: message.role,
        preview: getLocalCodexMessagePreview(message)
      }
    ];
  });
};

export const getLocalCodexSessionActivityTimestamp = (
  session: CodexSessionSummary
): string | null => session.updatedAt ?? session.createdAt ?? null;

const compareLocalCodexTimestampDesc = (
  left: string | null,
  right: string | null
): number => {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return right.localeCompare(left);
};

export const buildLocalCodexSessionTree = (
  sessions: CodexSessionSummary[]
): LocalCodexSessionTreeItem[] => {
  const sessionsById = new Map(sessions.map(session => [session.id, session]));
  const childrenByParentId = new Map<string, CodexSessionSummary[]>();
  const topLevelSessions: CodexSessionSummary[] = [];

  for (const session of sessions) {
    const parentSessionId = session.parentSessionId;
    const hasKnownParent =
      parentSessionId !== null &&
      parentSessionId !== session.id &&
      sessionsById.has(parentSessionId);

    if (isLocalCodexSubagentSession(session) && hasKnownParent) {
      const parentChildren = childrenByParentId.get(parentSessionId) ?? [];
      parentChildren.push(session);
      childrenByParentId.set(parentSessionId, parentChildren);
      continue;
    }

    topLevelSessions.push(session);
  }

  const treeItems = topLevelSessions.map(session => {
    const children = childrenByParentId.get(session.id) ?? [];
    children.sort((left, right) => {
      const timestampComparison = compareLocalCodexTimestampDesc(
        getLocalCodexSessionActivityTimestamp(left),
        getLocalCodexSessionActivityTimestamp(right)
      );
      return timestampComparison !== 0
        ? timestampComparison
        : left.id.localeCompare(right.id);
    });

    const childSortTimestamp =
      children
        .map(getLocalCodexSessionActivityTimestamp)
        .filter((timestamp): timestamp is string => timestamp !== null)
        .sort()
        .at(-1) ?? null;
    const ownSortTimestamp = getLocalCodexSessionActivityTimestamp(session);
    const sortTimestamp =
      compareLocalCodexTimestampDesc(ownSortTimestamp, childSortTimestamp) <= 0
        ? ownSortTimestamp
        : childSortTimestamp;

    return {
      session,
      children,
      isOrphanSubagent:
        isLocalCodexSubagentSession(session) &&
        (session.parentSessionId === null ||
          session.parentSessionId === session.id ||
          !sessionsById.has(session.parentSessionId)),
      sortTimestamp
    };
  });

  treeItems.sort((left, right) => {
    const timestampComparison = compareLocalCodexTimestampDesc(
      left.sortTimestamp,
      right.sortTimestamp
    );
    return timestampComparison !== 0
      ? timestampComparison
      : left.session.id.localeCompare(right.session.id);
  });

  return treeItems;
};

export const getVisibleLocalCodexSessionIds = (
  treeItems: LocalCodexSessionTreeItem[],
  expandedParentSessionIds: Set<string>
): string[] =>
  treeItems.flatMap(item => [
    item.session.id,
    ...(expandedParentSessionIds.has(item.session.id)
      ? item.children.map(child => child.id)
      : [])
  ]);

export const filterVisibleLocalCodexSessionSelection = (
  selectedSessionIds: Set<string>,
  treeItems: LocalCodexSessionTreeItem[],
  expandedParentSessionIds: Set<string>
): Set<string> => {
  const visibleSessionIds = new Set(
    getVisibleLocalCodexSessionIds(treeItems, expandedParentSessionIds)
  );
  return new Set(
    [...selectedSessionIds].filter(sessionId =>
      visibleSessionIds.has(sessionId)
    )
  );
};

const normalizeLocalCodexSessionSearchQuery = (query: string): string =>
  query.trim().toLowerCase();

const localCodexSessionSearchFields = (
  session: CodexSessionSummary
): string[] => [
  session.title,
  session.preview,
  session.cwd ?? 'Unknown project',
  session.agentNickname ?? '',
  session.id
];

const localCodexSessionMatchesQuery = (
  session: CodexSessionSummary,
  normalizedQuery: string
): boolean =>
  localCodexSessionSearchFields(session).some(field =>
    field.toLowerCase().includes(normalizedQuery)
  );

export const filterLocalCodexSessionTree = (
  treeItems: LocalCodexSessionTreeItem[],
  query: string
): FilterLocalCodexSessionTreeResult => {
  const normalizedQuery = normalizeLocalCodexSessionSearchQuery(query);
  const matchedSessionIds = new Set<string>();
  const autoExpandedParentSessionIds = new Set<string>();

  if (normalizedQuery === '') {
    return {
      treeItems,
      matchedSessionIds,
      autoExpandedParentSessionIds
    };
  }

  const filteredTreeItems = treeItems.flatMap(item => {
    const sessionMatches = localCodexSessionMatchesQuery(
      item.session,
      normalizedQuery
    );
    if (sessionMatches) {
      matchedSessionIds.add(item.session.id);
    }

    const matchingChildren = item.children.filter(child => {
      const childMatches = localCodexSessionMatchesQuery(
        child,
        normalizedQuery
      );
      if (childMatches) {
        matchedSessionIds.add(child.id);
      }
      return childMatches;
    });

    if (!sessionMatches && matchingChildren.length === 0) {
      return [];
    }

    if (matchingChildren.length > 0) {
      autoExpandedParentSessionIds.add(item.session.id);
    }

    // 搜索结果保留父子上下文，但只让真正命中的子会话进入结果，避免批量操作误选未命中会话。
    return [
      {
        ...item,
        children: matchingChildren
      }
    ];
  });

  return {
    treeItems: filteredTreeItems,
    matchedSessionIds,
    autoExpandedParentSessionIds
  };
};

// 让 sessions 页面直接跟随浏览器当前时区显示，避免把 UTC 字符串原样暴露给用户。
export const formatLocalCodexTimestamp = (
  timestamp: string | null | undefined
): string => {
  if (!timestamp) {
    return 'Unknown time';
  }

  const parsedTimestamp = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    return 'Unknown time';
  }

  return LOCAL_CODEX_TIMESTAMP_FORMATTER.format(new Date(parsedTimestamp));
};

const buildLocalCodexErrorMessage = (error: unknown): string => {
  const errorText = error instanceof Error ? error.message : String(error);
  return (
    'Failed to load local Codex sessions. ' +
    'Start the local FastAPI backend and refresh the browser. ' +
    `Details: ${errorText}`
  );
};

const buildLocalCodexDetailErrorMessage = (
  session: CodexSessionSummary,
  error: unknown
): string => {
  const errorText = error instanceof Error ? error.message : String(error);
  return (
    `Failed to load Codex session "${session.title}" (${session.id}). ` +
    'Refresh the local browser and select the session again. ' +
    `Details: ${errorText}`
  );
};

const buildLocalCodexProjectSessionsErrorMessage = (
  projectId: string,
  error: unknown
): string => {
  const errorText = error instanceof Error ? error.message : String(error);
  return (
    `Failed to load Codex sessions for project "${projectId}". ` +
    'Refresh the local browser and select the project again. ' +
    `Details: ${errorText}`
  );
};

export const loadLocalCodexBrowserState = async (
  api: LocalCodexBrowserListAPI,
  preferredProjectId: string | null = null,
  preferredSessionId: string | null = null,
  forceRefresh = false
): Promise<LocalCodexBrowserState> => {
  try {
    const projectsResponse = await api.listCodexProjects({
      refresh: forceRefresh
    });
    const selectedProject =
      projectsResponse.projects.find(
        project => project.id === preferredProjectId
      ) ??
      projectsResponse.projects.at(0) ??
      null;

    if (selectedProject === null) {
      return {
        projects: projectsResponse.projects,
        sessions: [],
        selectedProjectId: null,
        selectedSessionId: null,
        projectWarnings: projectsResponse.warnings,
        sessionWarnings: [],
        warnings: projectsResponse.warnings,
        errorMessage: ''
      };
    }

    const sessionsResponse = await api.listCodexProjectSessions(
      selectedProject.id
    );
    const selectedSession =
      sessionsResponse.sessions.find(
        session => session.id === preferredSessionId
      ) ?? null;

    return {
      projects: projectsResponse.projects,
      sessions: sessionsResponse.sessions,
      selectedProjectId: selectedProject.id,
      selectedSessionId: selectedSession?.id ?? null,
      projectWarnings: projectsResponse.warnings,
      sessionWarnings: sessionsResponse.warnings,
      warnings: mergeWarnings(
        projectsResponse.warnings,
        sessionsResponse.warnings
      ),
      errorMessage: ''
    };
  } catch (error) {
    return {
      projects: [],
      sessions: [],
      selectedProjectId: null,
      selectedSessionId: null,
      projectWarnings: [],
      sessionWarnings: [],
      warnings: [],
      errorMessage: buildLocalCodexErrorMessage(error)
    };
  }
};

export const loadLocalCodexProjectSessionsState = async (
  api: LocalCodexBrowserListAPI,
  projectId: string,
  projectWarnings: string[] = []
): Promise<LocalCodexProjectSessionsState> => {
  try {
    const sessionsResponse = await api.listCodexProjectSessions(projectId);
    return {
      sessions: sessionsResponse.sessions,
      selectedProjectId: projectId,
      selectedSessionId: null,
      sessionWarnings: sessionsResponse.warnings,
      warnings: mergeWarnings(projectWarnings, sessionsResponse.warnings),
      errorMessage: ''
    };
  } catch (error) {
    return {
      sessions: [],
      selectedProjectId: projectId,
      selectedSessionId: null,
      sessionWarnings: [],
      warnings: projectWarnings,
      errorMessage: buildLocalCodexProjectSessionsErrorMessage(projectId, error)
    };
  }
};

export const loadLocalCodexSessionDetail = async (
  api: LocalCodexSessionDetailAPI,
  session: CodexSessionSummary
): Promise<LocalCodexSessionDetailState> => {
  try {
    return {
      selectedSessionId: session.id,
      sessionData: await api.readCodexSession(session.id),
      errorMessage: ''
    };
  } catch (error) {
    return {
      selectedSessionId: session.id,
      sessionData: [],
      errorMessage: buildLocalCodexDetailErrorMessage(session, error)
    };
  }
};
