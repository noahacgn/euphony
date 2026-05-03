import type {
  CodexProjectSummary,
  CodexProjectsResponse,
  CodexSessionSummary,
  CodexSessionsResponse
} from '../../types/common-types';

export interface LocalCodexBrowserAPI {
  listCodexProjects: () => Promise<CodexProjectsResponse>;
  listCodexProjectSessions: (
    projectId: string
  ) => Promise<CodexSessionsResponse>;
}

export interface LocalCodexBrowserState {
  projects: CodexProjectSummary[];
  sessions: CodexSessionSummary[];
  selectedProjectId: string | null;
  warnings: string[];
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

export const loadLocalCodexBrowserState = async (
  api: LocalCodexBrowserAPI,
  preferredProjectId: string | null = null
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
        warnings: projectsResponse.warnings,
        errorMessage: ''
      };
    }

    const sessionsResponse = await api.listCodexProjectSessions(
      selectedProject.id
    );

    return {
      projects: projectsResponse.projects,
      sessions: sessionsResponse.sessions,
      selectedProjectId: selectedProject.id,
      warnings: [...projectsResponse.warnings, ...sessionsResponse.warnings],
      errorMessage: ''
    };
  } catch (error) {
    return {
      projects: [],
      sessions: [],
      selectedProjectId: null,
      warnings: [],
      errorMessage: buildLocalCodexErrorMessage(error)
    };
  }
};
