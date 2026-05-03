import type {
  CodexProjectSummary,
  CodexProjectsResponse,
  CodexSessionEvent,
  CodexSessionSummary,
  CodexSessionsResponse
} from '../../types/common-types';

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

const mergeWarnings = (...warningGroups: string[][]): string[] => [
  ...new Set(warningGroups.flat())
];

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
      projectsResponse.projects[0] ??
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
