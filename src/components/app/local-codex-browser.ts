import type {
  CodexProjectSummary,
  CodexProjectsResponse,
  CodexSessionEvent,
  CodexSessionSummary,
  CodexSessionsResponse
} from '../../types/common-types';

export interface LocalCodexBrowserListAPI {
  listCodexProjects: () => Promise<CodexProjectsResponse>;
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
  warnings: string[];
  errorMessage: string;
}

export interface LocalCodexSessionDetailState {
  selectedSessionId: string;
  sessionData: CodexSessionEvent[];
  errorMessage: string;
}

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

export const loadLocalCodexBrowserState = async (
  api: LocalCodexBrowserListAPI,
  preferredProjectId: string | null = null,
  preferredSessionId: string | null = null
): Promise<LocalCodexBrowserState> => {
  try {
    const projectsResponse = await api.listCodexProjects();
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
      warnings: [...projectsResponse.warnings, ...sessionsResponse.warnings],
      errorMessage: ''
    };
  } catch (error) {
    return {
      projects: [],
      sessions: [],
      selectedProjectId: null,
      selectedSessionId: null,
      warnings: [],
      errorMessage: buildLocalCodexErrorMessage(error)
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
