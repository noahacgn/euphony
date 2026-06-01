import { downloadText } from '@xiaohk/utils';
import { format } from 'd3-format';
import { css, html, LitElement, unsafeCSS, type TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type {
  CodexProjectSummary,
  CodexSessionSummary,
  HarmonyRenderRequest,
  MessageSharingRequest,
  RefreshRendererListRequest,
  TranslationRequest
} from '../../types/common-types';
import type { Conversation } from '../../types/harmony-types';
import {
  APIManager,
  BrowserAPIManager,
  EUPHONY_API_URL
} from '../../utils/api-manager';
import { isCodexSessionJSONL } from '../../utils/codex-session';
import { updatePopperOverlay } from '../../utils/utils';
import { EuphonyCodex } from '../codex/codex';
import { NightjarConfirmDialog } from '../confirm-dialog/confirm-dialog';
import {
  EuphonyConversation,
  parseConversationJSONString
} from '../conversation/conversation';
import { NightjarInputDialog } from '../input-dialog/input-dialog';
import type {
  FocusModeSettings,
  MessageLabelSettings
} from '../preference-window/preference-window';
import { EuphonySearchWindow } from '../search-window/search-window';
import { NightjarToast } from '../toast/toast';
import { EuphonyTokenWindow } from '../token-window/token-window';
import type { LocalDataWorkerMessage } from './local-data-worker';
import LocalDataWorkerInline from './local-data-worker?worker';
import {
  buildLocalCodexSessionTree,
  filterLocalCodexSessionTree,
  getVisibleLocalCodexSessionIds,
  isLocalCodexSubagentSession,
  loadLocalCodexBrowserState,
  loadLocalCodexProjectSessionsState,
  loadLocalCodexSessionDetail,
  formatLocalCodexTimestamp,
  type LocalCodexSessionTreeItem
} from './local-codex-browser';
import { RequestWorker } from './request-worker';
import { URLManager } from './url-manager';

import '@shoelace-style/shoelace/dist/components/copy-button/copy-button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import shoelaceCSS from '@shoelace-style/shoelace/dist/themes/light.css?inline';
import iconArrowUp from '../../images/icon-arrow-up.svg?raw';
import iconInfo from '../../images/icon-burger.svg?raw';
import iconCache from '../../images/icon-cache.svg?raw';
import iconClipboard from '../../images/icon-clipboard.svg?raw';
import iconCode from '../../images/icon-code-comment.svg?raw';
import iconClose from '../../images/icon-cross.svg?raw';
import iconEdit from '../../images/icon-edit.svg?raw';
import iconFilter from '../../images/icon-filter.svg?raw';
import iconChevronUpSm from '../../images/icon-chevron-up-sm.svg?raw';
import iconInfoSmall from '../../images/icon-info-circle-small.svg?raw';
import iconLaptop from '../../images/icon-macbook.svg?raw';
import iconSetting from '../../images/icon-settings.svg?raw';
import iconTrash from '../../images/icon-trash.svg?raw';

import '../codex/codex';
import '../confirm-dialog/confirm-dialog';
import '../conversation/conversation';
import '../input-dialog/input-dialog';
import '../json-viewer/json-viewer';
import '../menu/menu';
import '../pagination/pagination';
import '../preference-window/preference-window';
import '../search-window/search-window';
import '../toast/toast';
import '../token-window/token-window';

import componentCSS from './app.css?inline';

export interface ToastMessage {
  message: string;
  type: 'success' | 'warning' | 'error';
}

enum DataType {
  CONVERSATION = 'conversation',
  CODEX = 'codex',
  JSON = 'json'
}

type MenuItems =
  | 'Load without cache'
  | 'Load from clipboard'
  | 'Load local file'
  | 'Editor mode'
  | 'Leave editor mode'
  | 'Filter data'
  | 'Preferences'
  | 'Code';

const NUM_FORMATTER = format(',d');
const DEFAULT_ITEMS_PER_PAGE = 10;
const HEADER_HEIGHT = 72;
const LOCAL_CODEX_DELETE_ACTION_KEY = 'local-codex-session-delete';

type ToastType = 'success' | 'warning' | 'error';
const TOAST_DURATIONS: Record<ToastType, number> = {
  success: 6000,
  warning: 15000,
  error: 15000
};

type ConversationViewerElement = EuphonyConversation | EuphonyCodex;

let initURL = '';

// Check if the URL has query parameters
const urlParams = new URLSearchParams(window.location.search);
let blobPath = urlParams.get('path');

// User can set the index by url hash (e.g., #conversation-12) or url parameter
// (e.g., ?index=12). URL parameter is preferred because it can be sent to the
// server, but internally we use url hash for the scroll.
let conversationIndex = urlParams.get('index');
let urlHash = window.location.hash;
const messageIndexString: string | null = urlParams.get('subindex');
const messageIndex: number | null = messageIndexString
  ? parseInt(messageIndexString)
  : null;
if (conversationIndex !== null) {
  urlHash = `#conversation-${conversationIndex}`;
  window.location.hash = urlHash;
}

/**
 * App element.
 *
 */
@customElement('euphony-app')
export class EuphonyApp extends LitElement {
  //==========================================================================||
  //                              Class Properties                            ||
  //==========================================================================||
  @state()
  allConversationData: Conversation[] = [];

  @state()
  conversationData: Conversation[] = [];

  @state()
  JSONData: Record<string, unknown>[] = [];

  @state()
  codexSessionData: unknown[][] = [];

  @state()
  isLocalCodexBrowserMode = false;

  @state()
  localCodexProjects: CodexProjectSummary[] = [];

  @state()
  localCodexSessions: CodexSessionSummary[] = [];

  @state()
  localCodexSessionSearchQuery = '';

  @state()
  selectedLocalCodexSessionIDs = new Set<string>();

  @state()
  expandedLocalCodexParentSessionIDs = new Set<string>();

  @state()
  selectedLocalCodexProjectId: string | null = null;

  @state()
  selectedLocalCodexSessionId: string | null = null;

  @state()
  localCodexWarnings: string[] = [];

  @state()
  localCodexProjectWarnings: string[] = [];

  @state()
  isLoadingLocalCodexSessions = false;

  @state()
  localCodexErrorMessage = '';

  @state()
  localCodexSessionsErrorMessage = '';

  @state()
  localCodexDetailErrorMessage = '';

  @state()
  isLoadingLocalCodexSession = false;

  @state()
  isDeletingLocalCodexSessions = false;

  @state()
  dataType: DataType = DataType.CONVERSATION;

  @state()
  isLoadingData = false;

  @state()
  curPage = 1;

  @state()
  globalIsShowingMetadata = false;

  @state()
  globalShouldRenderMarkdown = false;

  @state()
  jmespathQuery = '';

  // Focus mode settings
  @state()
  focusModeAuthor: string[] = [];

  @state()
  focusModeRecipient: string[] = [];

  @state()
  focusModeContentType: string[] = [];

  // Nightjar component
  @query('nightjar-toast#toast-euphony')
  toastComponent: NightjarToast | undefined;

  @state()
  toastMessage = '';

  @state()
  toastType: 'success' | 'warning' | 'error' = 'success';

  @query('nightjar-confirm-dialog')
  confirmDialogComponent: NightjarConfirmDialog | undefined;

  @query('nightjar-input-dialog')
  inputDialogComponent: NightjarInputDialog | undefined;

  @query('euphony-search-window')
  searchWindowComponent: EuphonySearchWindow | undefined;

  @query('euphony-token-window')
  tokenWindowComponent: EuphonyTokenWindow | undefined;

  @query('.conversation-grid')
  conversationGridElement: HTMLElement | undefined | null;

  @query('#local-file-input')
  localFileInputElement: HTMLInputElement | undefined;

  apiManager = new APIManager(EUPHONY_API_URL);
  requestWorker = new RequestWorker(EUPHONY_API_URL);
  browserAPIManager = new BrowserAPIManager();

  // Shared state to ensure we prompt only once and queue concurrent requests
  private pendingOpenAIKeyPromise: Promise<string | null> | null = null;

  // Euphony style config
  euphonyStyleConfig: Record<string, string> = {};

  // App style config
  appStyleConfig: Record<string, string> = {};

  // Pagination
  @state()
  itemsPerPage = DEFAULT_ITEMS_PER_PAGE;
  _totalConversationSize = 0;
  _totalConversationSizeIncludingUnfiltered = 0;

  // Cache setting
  // If user provides no-cache=true or clicks reload without cache, we record the
  // blob path here. It's necessary so we will load without cache when user
  // changes pages / limits / searches.
  noCacheBlobPaths = new Set<string>();

  get totalConversationSize() {
    return this._totalConversationSize;
  }

  get totalPageNum() {
    return Math.ceil(this._totalConversationSize / this.itemsPerPage);
  }

  get totalConversationSizeIncludingUnfiltered() {
    return this._totalConversationSizeIncludingUnfiltered;
  }

  // Editor mode
  @state()
  isEditorMode = false;

  @state()
  selectedConversationIDs = new Set<number>();

  // Frontend only mode
  @state()
  isFrontendOnlyMode =
    (import.meta.env.VITE_EUPHONY_FRONTEND_ONLY as string | undefined) !==
    'false';

  // Tool bar menu
  @state()
  showToolBarMenu = false;

  @state()
  isLoadingFromCache = true;

  @state()
  isLoadingFromClipboard = false;

  // Grid view mode
  @state()
  isGridView = false;

  @state()
  gridViewColumnWidth = 300;
  comparisonColumnWidth = 300;

  // Popups and tooltips
  @state()
  showPreferenceWindow = false;

  @query('#popper-tooltip')
  popperTooltip: HTMLElement | undefined;

  // Scrolling
  @state()
  showScrollTopButton = false;

  // URL manager
  urlManager: URLManager;
  localDataWorker: Worker;
  localDataWorkerRequestCount = 0;
  get localDataWorkerRequestID() {
    return this.localDataWorkerRequestCount++;
  }
  activeLocalDataWorkerRequestID: number | null = null;
  localCodexSessionRequestCount = 0;
  activeLocalCodexSessionRequestID: number | null = null;
  localDataWorkerPendingRequests = new Map<
    number,
    {
      resolve: () => void;
      reject: (reason?: unknown) => void;
    }
  >();

  // Debouncers
  cacheInfoTooltipDebouncer: number | null = null;

  //==========================================================================||
  //                             Lifecycle Methods                            ||
  //==========================================================================||
  constructor() {
    super();

    this.urlManager = new URLManager(this);
    this.localDataWorker = new LocalDataWorkerInline();
    this.localDataWorker.addEventListener(
      'message',
      (e: MessageEvent<LocalDataWorkerMessage>) => {
        this.localDataWorkerMessageHandler(e);
      }
    );

    // Update the configs based on the current URL
    this.urlManager.updateConfigsFromURL();

    // Because we are using web components, we can't directly use anchor links
    // to scroll to different sections. Instead, we will listen to hash changes
    // and scroll to the element with the corresponding ID manually.
    window.addEventListener('hashchange', () => {
      this.hashChanged().then(
        () => {},
        () => {}
      );
    });

    // Allow users to press left and right arrow keys to navigate between pages
    // And use up and down arrow keys to navigate between conversations in the
    // current page
    document.addEventListener('keydown', event => {
      switch (event.key) {
        case 'ArrowLeft':
          // Handle left arrow key press <-
          if (this.curPage > 1) {
            this.updatePageNumber(this.curPage - 1, true).then(
              () => {},
              () => {}
            );
          }
          break;
        case 'ArrowRight':
          // Handle right arrow key press ->
          if (this.curPage + 1 <= this.totalPageNum) {
            this.updatePageNumber(this.curPage + 1, true).then(
              () => {},
              () => {}
            );
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          // Handle up arrow key press ^
          if (urlHash === '') {
            // If there is no hash, we scroll to the first conversation
            urlHash = `#conversation-${(this.curPage - 1) * this.itemsPerPage}`;
          } else {
            const conversationIndex = parseInt(
              urlHash.replace('#conversation-', '')
            );
            if (conversationIndex > (this.curPage - 1) * this.itemsPerPage) {
              urlHash = `#conversation-${conversationIndex - 1}`;
            } else {
              // Loop back to the last conversation in the current page
              urlHash = `#conversation-${Math.min(
                this.totalConversationSize - 1,
                this.curPage * this.itemsPerPage - 1
              )}`;
            }
          }
          history.pushState({}, '', urlHash);
          this.scrollToConversation(urlHash, 'instant');
          break;
        case 'ArrowDown':
          event.preventDefault();
          // Handle down arrow key press
          if (urlHash === '') {
            // If there is no hash, we scroll to the first conversation
            urlHash = `#conversation-${(this.curPage - 1) * this.itemsPerPage}`;
          } else {
            const conversationIndex = parseInt(
              urlHash.replace('#conversation-', '')
            );
            if (
              conversationIndex <
              Math.min(
                this.totalConversationSize - 1,
                this.curPage * this.itemsPerPage - 1
              )
            ) {
              urlHash = `#conversation-${conversationIndex + 1}`;
            } else {
              // Loop back to the first conversation in the current page
              const newIndex = (this.curPage - 1) * this.itemsPerPage;
              urlHash = `#conversation-${newIndex}`;
            }
          }
          this.scrollToConversation(urlHash, 'instant');
          history.pushState({}, '', urlHash);
          break;
        default:
          break;
      }
    });
  }

  disconnectedCallback(): void {
    this.localDataWorker.terminate();
    super.disconnectedCallback();
  }

  /**
   * This method is called when the DOM is added for the first time
   */
  firstUpdated() {
    window.setTimeout(() => {
      this.initData().then(
        () => {},
        () => {}
      );
    });

    // Show the scroll top button when the user scrolls down
    const appElement = this.shadowRoot?.querySelector('.app');
    if (appElement) {
      appElement.addEventListener('scroll', () => {
        const scrollTotal = appElement.scrollHeight - appElement.clientHeight;
        if (
          appElement.scrollTop / scrollTotal > 0.1 ||
          appElement.scrollTop > 100
        ) {
          this.showScrollTopButton = true;
        } else {
          this.showScrollTopButton = false;
        }
      });
    }
  }

  //==========================================================================||
  //                              Custom Methods                              ||
  //==========================================================================||
  async initData() {
    this.isLoadingData = true;

    // If user has specified a hash, we need to jump to that particular page
    // containing the conversation
    if (conversationIndex !== null) {
      const conversationIndexNumber = parseInt(conversationIndex);
      this.curPage =
        Math.floor(conversationIndexNumber / this.itemsPerPage) + 1;
    }

    if (blobPath === null) {
      await this.refreshLocalCodexSessions();
    } else {
      initURL = blobPath;

      // Check if we should avoid using cache
      const noCache = urlParams.get('no-cache') === 'true';

      // Track the noCache setting
      if (noCache) {
        this.noCacheBlobPaths.add(initURL);
      }

      // Run a query to get the data
      await this.loadData({
        blobURL: initURL,
        offset: (this.curPage - 1) * this.itemsPerPage,
        limit: this.itemsPerPage,
        showSuccessToast: false,
        noCache,
        jmespathQuery: this.jmespathQuery
      });
    }

    // If the user has provided both urlHash and messageIndex -> scroll to the message
    if (urlHash !== '' && messageIndex !== null) {
      await this.allChildrenUpdateComplete();
      this.scrollToMessage(urlHash, messageIndex);
    } else if (urlHash !== '') {
      // If only urlHash is set -> scroll to the conversation
      await this.allChildrenUpdateComplete();
      this.scrollToConversation(urlHash);
    }
  }

  clearRenderedData() {
    this.codexSessionData = [];
    this.allConversationData = [];
    this.conversationData = [];
    this.JSONData = [];
    this.selectedConversationIDs = new Set();
    this._totalConversationSize = 0;
    this._totalConversationSizeIncludingUnfiltered = 0;
  }

  clearLocalCodexSessionDetailState() {
    this.selectedLocalCodexSessionId = null;
    this.localCodexDetailErrorMessage = '';
    this.isLoadingLocalCodexSession = false;
    this.activeLocalCodexSessionRequestID = null;
    this.clearRenderedData();
    this.dataType = DataType.CONVERSATION;
  }

  syncSelectedLocalCodexSessionIDs() {
    const selectableSessionIds = new Set(
      this.getSelectableLocalCodexSessionIds()
    );
    this.selectedLocalCodexSessionIDs = new Set(
      [...this.selectedLocalCodexSessionIDs].filter(sessionId =>
        selectableSessionIds.has(sessionId)
      )
    );
  }

  getSelectableLocalCodexSessionIds(): string[] {
    const sessionTree = buildLocalCodexSessionTree(this.localCodexSessions);
    const searchQuery = this.localCodexSessionSearchQuery.trim();
    if (searchQuery !== '') {
      return [
        ...filterLocalCodexSessionTree(sessionTree, searchQuery)
          .matchedSessionIds
      ];
    }

    return getVisibleLocalCodexSessionIds(
      sessionTree,
      this.expandedLocalCodexParentSessionIDs
    );
  }

  toggleLocalCodexSessionSelection(
    sessionId: string,
    isSelected: boolean
  ): void {
    const nextSelectedSessionIDs = new Set(this.selectedLocalCodexSessionIDs);
    if (isSelected) {
      nextSelectedSessionIDs.add(sessionId);
    } else {
      nextSelectedSessionIDs.delete(sessionId);
    }
    this.selectedLocalCodexSessionIDs = nextSelectedSessionIDs;
  }

  toggleSelectAllLocalCodexSessions(): void {
    const selectableSessionIds = this.getSelectableLocalCodexSessionIds();
    if (selectableSessionIds.length === 0) {
      return;
    }

    const selectableSessionIdSet = new Set(selectableSessionIds);
    const selectedSelectableSessionCount = [
      ...this.selectedLocalCodexSessionIDs
    ].filter(sessionId => selectableSessionIdSet.has(sessionId)).length;

    if (selectedSelectableSessionCount === selectableSessionIds.length) {
      this.selectedLocalCodexSessionIDs = new Set();
      return;
    }

    this.selectedLocalCodexSessionIDs = new Set(selectableSessionIds);
  }

  localCodexSessionSearchInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.localCodexSessionSearchQuery = target.value;
    this.syncSelectedLocalCodexSessionIDs();
  }

  clearLocalCodexSessionSearch(): void {
    if (this.localCodexSessionSearchQuery === '') {
      return;
    }

    this.localCodexSessionSearchQuery = '';
    this.syncSelectedLocalCodexSessionIDs();
  }

  toggleLocalCodexParentSessionExpansion(
    parentSessionId: string,
    childSessionIds: string[]
  ): void {
    const nextExpandedSessionIDs = new Set(
      this.expandedLocalCodexParentSessionIDs
    );
    const shouldCollapse = nextExpandedSessionIDs.has(parentSessionId);

    if (shouldCollapse) {
      nextExpandedSessionIDs.delete(parentSessionId);
      const childSessionIdSet = new Set(childSessionIds);
      this.selectedLocalCodexSessionIDs = new Set(
        [...this.selectedLocalCodexSessionIDs].filter(
          sessionId => !childSessionIdSet.has(sessionId)
        )
      );
    } else {
      nextExpandedSessionIDs.add(parentSessionId);
    }

    this.expandedLocalCodexParentSessionIDs = nextExpandedSessionIDs;
  }

  promptLocalCodexSessionDeletion(
    sessionIds: string[],
    description: string
  ): void {
    if (sessionIds.length === 0) {
      return;
    }

    const deleteLabel =
      sessionIds.length === 1 ? 'Delete session' : 'Delete selected';
    this.confirmDialogComponent?.show(
      {
        header:
          sessionIds.length === 1
            ? 'Delete Codex session'
            : 'Delete Codex sessions',
        message:
          sessionIds.length === 1
            ? `Delete the rollout JSONL file for ${description}? ` +
              'This permanently removes the file from disk and cannot be undone.'
            : `Delete ${NUM_FORMATTER(
                sessionIds.length
              )} selected rollout JSONL files from disk? ` +
              'This permanently removes the files and cannot be undone.',
        yesButtonText: deleteLabel,
        actionKey: LOCAL_CODEX_DELETE_ACTION_KEY
      },
      () => {
        this.deleteLocalCodexSessions(sessionIds).then(
          () => {},
          () => {}
        );
      }
    );
  }

  async deleteLocalCodexSessions(sessionIds: string[]): Promise<void> {
    const normalizedSessionIds = [...new Set(sessionIds)].filter(
      sessionId => sessionId.trim() !== ''
    );
    if (normalizedSessionIds.length === 0) {
      return;
    }

    const currentProjectId = this.selectedLocalCodexProjectId;
    const deletedSessionIdSet = new Set(normalizedSessionIds);
    const selectedSessionWasDeleted =
      this.selectedLocalCodexSessionId !== null &&
      deletedSessionIdSet.has(this.selectedLocalCodexSessionId);

    this.isDeletingLocalCodexSessions = true;
    try {
      await this.apiManager.deleteCodexSessions(normalizedSessionIds);

      this.selectedLocalCodexSessionIDs = new Set(
        [...this.selectedLocalCodexSessionIDs].filter(
          sessionId => !deletedSessionIdSet.has(sessionId)
        )
      );

      if (selectedSessionWasDeleted) {
        this.clearLocalCodexSessionDetailState();
      }

      await this.refreshLocalCodexSessions(currentProjectId, true);
      this.syncSelectedLocalCodexSessionIDs();

      this.toastMessage =
        normalizedSessionIds.length === 1
          ? `Deleted Codex session ${normalizedSessionIds[0]}.`
          : `Deleted ${NUM_FORMATTER(normalizedSessionIds.length)} Codex sessions.`;
      this.toastType = 'success';
      this.toastComponent?.show();
    } catch (error) {
      this.toastMessage = `Failed to delete local Codex sessions.\n\n${
        error instanceof Error ? error.message : String(error)
      }`;
      this.toastType = 'error';
      this.toastComponent?.show();
    } finally {
      this.isDeletingLocalCodexSessions = false;
    }
  }

  async refreshLocalCodexSessions(
    preferredProjectId: string | null = this.selectedLocalCodexProjectId,
    forceRefresh = false
  ) {
    const isChangingProject =
      preferredProjectId !== this.selectedLocalCodexProjectId;
    const preferredSessionId = isChangingProject
      ? null
      : this.selectedLocalCodexSessionId;

    this.isLocalCodexBrowserMode = true;
    this.isLoadingData = true;
    this.isLoadingFromCache = false;
    this.isLoadingFromClipboard = false;
    this.clearRenderedData();
    this.dataType = DataType.CONVERSATION;
    this.localCodexDetailErrorMessage = '';
    this.localCodexSessionsErrorMessage = '';
    this.isLoadingLocalCodexSessions = false;
    this.isLoadingLocalCodexSession = false;
    this.activeLocalCodexSessionRequestID = null;
    this.expandedLocalCodexParentSessionIDs = new Set();
    if (isChangingProject) {
      this.localCodexSessionSearchQuery = '';
    }

    const localState = await loadLocalCodexBrowserState(
      this.apiManager,
      preferredProjectId,
      preferredSessionId,
      forceRefresh
    );

    this.localCodexProjects = localState.projects;
    this.localCodexSessions = localState.sessions;
    this.selectedLocalCodexProjectId = localState.selectedProjectId;
    this.selectedLocalCodexSessionId = localState.selectedSessionId;
    this.localCodexProjectWarnings = localState.projectWarnings;
    this.localCodexWarnings = localState.warnings;
    this.localCodexErrorMessage = localState.errorMessage;
    this.syncSelectedLocalCodexSessionIDs();

    if (
      preferredSessionId !== null &&
      localState.selectedSessionId === preferredSessionId
    ) {
      const selectedSession = localState.sessions.find(
        session => session.id === preferredSessionId
      );
      if (selectedSession) {
        await this.openLocalCodexSession(selectedSession, false);
      }
    }

    this.isLoadingData = false;
  }

  async loadLocalCodexProjectSessions(projectId: string) {
    this.isLocalCodexBrowserMode = true;
    this.isLoadingLocalCodexSessions = true;
    this.isLoadingLocalCodexSession = false;
    this.activeLocalCodexSessionRequestID = null;
    this.selectedLocalCodexProjectId = projectId;
    this.selectedLocalCodexSessionId = null;
    this.localCodexSessions = [];
    this.localCodexErrorMessage = '';
    this.localCodexSessionsErrorMessage = '';
    this.localCodexDetailErrorMessage = '';
    this.selectedLocalCodexSessionIDs = new Set();
    this.expandedLocalCodexParentSessionIDs = new Set();
    this.localCodexSessionSearchQuery = '';
    this.clearRenderedData();
    this.dataType = DataType.CONVERSATION;

    const localState = await loadLocalCodexProjectSessionsState(
      this.apiManager,
      projectId,
      this.localCodexProjectWarnings
    );

    if (projectId !== this.selectedLocalCodexProjectId) {
      return;
    }

    this.localCodexSessions = localState.sessions;
    this.selectedLocalCodexProjectId = localState.selectedProjectId;
    this.selectedLocalCodexSessionId = localState.selectedSessionId;
    this.localCodexWarnings = localState.warnings;
    this.localCodexSessionsErrorMessage = localState.errorMessage;
    this.syncSelectedLocalCodexSessionIDs();
    this.isLoadingLocalCodexSessions = false;
  }

  //==========================================================================||
  //                              Event Handlers                              ||
  //==========================================================================||
  /**
   * Load the JSONL file from the URL provided in the input element
   * @returns
   */
  async loadButtonClicked({ noCache = false }: { noCache?: boolean } = {}) {
    const inputElement = this.shadowRoot?.querySelector('sl-input');
    urlHash = '';

    if (!inputElement) {
      throw new Error('Input element not found');
    }

    // Get the blob URL from the input element
    let blobURL = inputElement.value.trim();
    if (blobURL === '') {
      return;
    }

    // Sometimes the user would copy the euphony url to the input bar, parse
    // the real blob url from the euphony url
    const regex = /[?&]path=([^&#]+)/;
    const match = regex.exec(blobURL);
    if (match?.[1]) {
      blobURL = decodeURIComponent(match[1]);
    }

    // Track the noCache setting
    if (noCache) {
      this.noCacheBlobPaths.add(blobURL);
    }
    if (this.noCacheBlobPaths.has(blobURL)) {
      noCache = true;
    }

    this.curPage = 1;
    const { isLoadDataSuccessful, loadedURL } = await this.loadData({
      blobURL,
      offset: (this.curPage - 1) * this.itemsPerPage,
      limit: this.itemsPerPage,
      noCache
    });

    if (isLoadDataSuccessful) {
      // The urls can include invalid URL characters like '+', we need to
      // encode them before updating the URL
      console.log('loadedURL', loadedURL);
      let query = `?path=${encodeURIComponent(loadedURL)}`;
      if (noCache) {
        query += '&no-cache=true';
      }

      if (this.itemsPerPage !== DEFAULT_ITEMS_PER_PAGE) {
        query += `&limit=${this.itemsPerPage}`;
      }

      if (this.isGridView) {
        query += `&grid=${this.gridViewColumnWidth}`;
      }

      history.pushState({}, '', query);
      blobPath = loadedURL;
      inputElement.value = loadedURL;
    }
  }

  /**
   * Serialize the current data and download it as a JSONL file
   */
  downloadButtonClicked() {
    const elements = this.shadowRoot?.querySelectorAll<EuphonyConversation>(
      'euphony-conversation'
    );
    const jsonStrings: string[] = [];
    if (elements) {
      for (const element of elements) {
        const sharingURL = element.sharingURL;
        let conversationID: number | undefined;
        if (sharingURL) {
          const urlObj = new URL(sharingURL);
          const indexParam = urlObj.searchParams.get('index');
          if (indexParam !== null) {
            conversationID = parseInt(indexParam);
          }
        }
        if (conversationID === undefined) {
          continue;
        }
        if (!this.selectedConversationIDs.has(conversationID)) {
          continue;
        }
        const editedConversation = element.getEditedConversationData();
        if (editedConversation === null) {
          continue;
        }
        jsonStrings.push(JSON.stringify(editedConversation));
      }
    }

    const jsonLString = jsonStrings.join('\n');
    let fileName = 'conversation.jsonl';
    if (blobPath !== null) {
      fileName = blobPath.split('/').pop() ?? 'conversation.jsonl';
    }
    fileName = fileName.replace('.jsonl', '-edited.jsonl');
    downloadText(jsonLString, null, fileName);
  }

  selectAllButtonClicked() {
    if (this.selectedConversationIDs.size !== this.totalConversationSize) {
      // Select all
      this.selectedConversationIDs = new Set();
      for (let i = 0; i < this.totalConversationSize; i++) {
        this.selectedConversationIDs.add(i);
        const conversationElement =
          this.shadowRoot?.querySelector<EuphonyConversation>(
            `#euphony-conversation-${i}`
          );
        if (conversationElement) {
          conversationElement.isConvoMarkedForDeletion = false;
        }
      }
    } else {
      // Unselect all
      this.selectedConversationIDs = new Set();
      for (let i = 0; i < this.totalConversationSize; i++) {
        const conversationElement =
          this.shadowRoot?.querySelector<EuphonyConversation>(
            `#euphony-conversation-${i}`
          );
        if (conversationElement) {
          conversationElement.isConvoMarkedForDeletion = true;
        }
      }
    }
  }

  async updatePageNumber(newPageNumber: number, scrollToTop: boolean) {
    this.curPage = newPageNumber;
    // Reset the hash when the page number is updated
    this.resetHash();

    // Two cases
    // Case 1: We are loading the local demo data. We can simply slice the data
    // Case 2: We are loading the real user's remote data. We need to fetch the
    // the data in the desired page.

    // Case 1: Local demo data
    if (blobPath === null) {
      this.conversationData = this.allConversationData.slice(
        (this.curPage - 1) * this.itemsPerPage,
        this.curPage * this.itemsPerPage
      );
    } else {
      // Case 2: Real user's remote data
      let noCache = false;
      if (this.noCacheBlobPaths.has(blobPath)) {
        noCache = true;
      } else {
        noCache = urlParams.get('no-cache') === 'true';
      }
      await this.loadData({
        blobURL: blobPath,
        offset: (this.curPage - 1) * this.itemsPerPage,
        limit: this.itemsPerPage,
        showSuccessToast: false,
        noCache,
        jmespathQuery: this.jmespathQuery
      });
    }

    if (scrollToTop) {
      this.scrollToTop(0);
    }

    // Update the URL
    this.urlManager.updateURL();
  }

  pageClicked(e: CustomEvent<number>) {
    this.updatePageNumber(e.detail, true).then(
      () => {},
      () => {}
    );
  }

  itemsPerPageChanged(e: CustomEvent<number>) {
    this.itemsPerPage = e.detail;

    // Update the page number based on the new items per page
    this.updatePageNumber(1, true).then(
      () => {},
      () => {}
    );
  }

  async hashChanged() {
    urlHash = window.location.hash;
    conversationIndex = urlParams.get('index');
    if (conversationIndex !== null) {
      urlHash = `#conversation-${conversationIndex}`;
    }

    // Check if we need to update the page number based on the conversation ID
    if (urlHash !== '') {
      const conversationIndex = parseInt(urlHash.replace('#conversation-', ''));
      const newPageNumber =
        Math.floor(conversationIndex / this.itemsPerPage) + 1;

      if (
        newPageNumber !== this.curPage &&
        newPageNumber <= this.totalPageNum
      ) {
        await this.updatePageNumber(newPageNumber, false);
      }
    }

    this.allChildrenUpdateComplete().then(
      () => {
        this.scrollToConversation(urlHash);
      },
      () => {}
    );
  }

  async conversationMetadataButtonToggled(e: CustomEvent<boolean>) {
    const containerElement = this.shadowRoot?.querySelector('.app');
    if (!containerElement) {
      throw Error('App element not found');
    }

    /**
     * Scroll the app element so that the active conversation stays at the same
     * y position after the size shift due to metadata expansion.
     */
    const conversationElement = e.target as EuphonyConversation;
    const originalConversationTop =
      conversationElement.getBoundingClientRect().top;

    this.globalIsShowingMetadata = e.detail;
    await this.allChildrenUpdateComplete();

    const newConversationTop = conversationElement.getBoundingClientRect().top;
    containerElement.scrollTop += newConversationTop - originalConversationTop;

    // Update the URL
    this.urlManager.updateURL();
  }

  async markdownButtonToggled(e: CustomEvent<boolean>) {
    const containerElement = this.shadowRoot?.querySelector('.app');
    if (!containerElement) {
      throw Error('App element not found');
    }

    /**
     * Scroll the app element so that the active conversation stays at the same
     * y position after the size shift due to markdown rendering
     */
    const conversationElement = e.target as EuphonyConversation;
    const originalConversationTop =
      conversationElement.getBoundingClientRect().top;

    this.globalShouldRenderMarkdown = e.detail;
    await this.allChildrenUpdateComplete();

    const newConversationTop = conversationElement.getBoundingClientRect().top;
    containerElement.scrollTop += newConversationTop - originalConversationTop;

    // Update the URL
    this.urlManager.updateURL();
  }

  menuItemClicked(e: CustomEvent<MenuItems>) {
    switch (e.detail) {
      case 'Preferences': {
        this.showPreferenceWindow = true;
        break;
      }
      case 'Load without cache': {
        this.loadButtonClicked({ noCache: true }).then(
          () => {},
          () => {}
        );
        break;
      }
      case 'Load from clipboard': {
        this.isLoadingData = true;
        navigator.clipboard.readText().then(
          async clipText => {
            await this.loadDataFromText(clipText, 'clipboard');
          },
          (err: unknown) => {
            console.error('Failed to read clipboard contents: ', err);
            this.isLoadingData = false;
          }
        );
        break;
      }
      case 'Load local file': {
        this.localFileInputElement?.click();
        break;
      }
      case 'Editor mode': {
        this.confirmDialogComponent?.show(
          {
            header: 'No pagination in editor mode',
            message:
              'Editor mode will display all conversations in the JSONL file ' +
              'on a single page, which may cause your browser to slow down ' +
              'or crash if there are too many conversations loaded ' +
              '(e.g., >500).',
            yesButtonText: 'I understand, enter',
            actionKey: 'editor-mode'
          },
          () => {
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('editor', 'true');
            currentUrl.searchParams.set('page', '1');
            window.location.href = currentUrl.toString();
          }
        );
        break;
      }
      case 'Leave editor mode': {
        this.confirmDialogComponent?.show(
          {
            header: 'Download the edited JSONL file',
            message:
              'Make sure you have downloaded the edited JSONL file before ' +
              'leaving editor mode. Otherwise, you will lose all your changes.',
            yesButtonText: 'Okay',
            actionKey: 'leave-editor-mode'
          },
          () => {
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.delete('editor');
            currentUrl.searchParams.delete('page');
            window.location.href = currentUrl.toString();
          }
        );
        break;
      }
      case 'Filter data': {
        this.searchWindowComponent?.show();
        break;
      }
      case 'Code': {
        window.open('https://github.com/openai/euphony', '_blank');
        break;
      }
      default: {
        console.error('Unknown menu item clicked', e.detail);
        break;
      }
    }
  }

  cacheInfoMouseEnter(e: MouseEvent) {
    if (!this.popperTooltip) {
      throw Error('Popper tooltip not initialized.');
    }

    const anchor = e.currentTarget as HTMLElement;

    if (this.cacheInfoTooltipDebouncer) {
      clearTimeout(this.cacheInfoTooltipDebouncer);
    }

    this.cacheInfoTooltipDebouncer = window.setTimeout(() => {
      // Update the content
      const labelElement = this.popperTooltip!.querySelector('.popper-label');
      labelElement!.textContent =
        'This data is cached for 60 minutes and may be outdated. ' +
        'Click "Load without cache" in the top-right menu to refetch.';

      updatePopperOverlay(this.popperTooltip!, anchor, 'top', true, 7, 300);
      this.popperTooltip!.classList.remove('hidden');
    }, 300);
  }

  cacheInfoMouseLeave(useTransition = true) {
    if (!this.popperTooltip) {
      throw Error('popperTooltip are not initialized yet.');
    }

    if (this.cacheInfoTooltipDebouncer) {
      clearTimeout(this.cacheInfoTooltipDebouncer);
      this.cacheInfoTooltipDebouncer = null;
    }

    if (useTransition) {
      this.popperTooltip.classList.add('hidden');
    } else {
      this.popperTooltip.classList.add('no-transition');
      this.popperTooltip.classList.add('hidden');
      setTimeout(() => {
        this.popperTooltip!.classList.remove('no-transition');
      }, 150);
    }
  }

  preferenceWindowMaxMessageHeightChanged(e: CustomEvent<string>) {
    const newHeight = e.detail;
    this.euphonyStyleConfig['--euphony-max-message-height'] = newHeight;
    this.requestUpdate();
  }

  preferenceWindowMessageLabelChanged(e: CustomEvent<MessageLabelSettings>) {
    for (const element of this.getConversationViewerElements()) {
      element.preferenceWindowMessageLabelChanged(e);
    }
  }

  preferenceWindowGridViewColumnWidthChanged(e: CustomEvent<string>) {
    const newWidth = e.detail;
    this.gridViewColumnWidth = parseInt(newWidth);
    this.appStyleConfig['--app-grid-view-column-width'] = newWidth;
    this.requestUpdate();
    this.urlManager.updateURL();
  }

  preferenceWindowComparisonWidthChanged(e: CustomEvent<string>) {
    const newWidth = e.detail;
    this.comparisonColumnWidth = parseInt(newWidth);
    // Pass the CSS variable down to every comparison component via style binding.
    this.euphonyStyleConfig['--comparison-grid-column-width'] = newWidth;
    this.requestUpdate();
  }

  preferenceWindowLayoutChanged(e: CustomEvent<string>) {
    const newLayout = e.detail;
    if (newLayout === 'grid') {
      this.isGridView = true;
    } else if (newLayout === 'list') {
      this.isGridView = false;
    } else {
      throw Error('Unknown layout: ' + newLayout);
    }
    // Update the URL
    this.urlManager.updateURL();
    this.requestUpdate();
  }

  preferenceWindowExpandAllClicked() {
    for (const element of this.getConversationViewerElements()) {
      element.expandBlockContents();
    }
  }

  preferenceWindowCollapseAllClicked() {
    for (const element of this.getConversationViewerElements()) {
      element.collapseBlockContents();
    }
  }

  preferenceWindowTranslateAllClicked() {
    for (const element of this.getConversationViewerElements()) {
      void element.translationButtonClicked();
    }
  }

  preferenceWindowFocusModeSettingsChanged(e: CustomEvent<FocusModeSettings>) {
    const focusModeSettings = e.detail;
    this.focusModeAuthor = [...focusModeSettings.author];
    this.focusModeRecipient = [...focusModeSettings.recipient];
    this.focusModeContentType = [...focusModeSettings.contentType];

    for (const element of this.getConversationViewerElements()) {
      element.preferenceWindowFocusModeSettingsChanged(e);
    }
  }

  async searchWindowQuerySubmitted(e: CustomEvent<string>) {
    if (blobPath === null) {
      throw Error('Blob path is not set');
    }

    const query = e.detail;
    this.curPage = 1;
    let noCache = false;
    if (this.noCacheBlobPaths.has(blobPath)) {
      noCache = true;
    } else {
      noCache = urlParams.get('no-cache') === 'true';
    }

    const { isLoadDataSuccessful, loadDataMessage } = await this.loadData({
      blobURL: blobPath,
      offset: (this.curPage - 1) * this.itemsPerPage,
      limit: this.itemsPerPage,
      jmespathQuery: query,
      noCache: noCache
    });

    if (isLoadDataSuccessful) {
      this.searchWindowComponent?.searchSucceeded();
      // Update the jmespath query and URL
      this.jmespathQuery = query;
      this.urlManager.updateURL();
    } else {
      this.searchWindowComponent?.searchFailed(loadDataMessage);
    }
  }

  /**
   * Show the token window when user clicks on the harmony render button
   * @param e CustomEvent<string> - The custom event containing the conversation string
   */
  harmonyRenderButtonClicked(e: CustomEvent<string>) {
    const conversationString = e.detail;
    if (this.tokenWindowComponent) {
      this.tokenWindowComponent.show(conversationString);
    }
  }

  //==========================================================================||
  //                             Private Helpers                              ||
  //==========================================================================||
  /**
   * Ensures an OpenAI API key is available in localStorage.
   * - If present, resolves immediately with the key.
   * - If absent, shows a single input dialog and returns a shared Promise so
   *   concurrent requests wait for the same user action.
   * - Resolves to null if the user cancels.
   */
  private ensureOpenAIAPIKey(): Promise<string | null> {
    const storedKey = localStorage.getItem('openAIAPIKey');
    if (storedKey) {
      return Promise.resolve(storedKey);
    }

    if (this.pendingOpenAIKeyPromise) {
      return this.pendingOpenAIKeyPromise;
    }

    this.pendingOpenAIKeyPromise = new Promise<string | null>(resolve => {
      this.inputDialogComponent?.show(
        {
          header: 'Enter OpenAI API Key',
          message:
            'To use translation in frontend-only mode, you must provide ' +
            'your own OpenAI API key. The key will only be stored in your browser.',
          yesButtonText: 'Continue'
        },
        (input: string) => {
          // Confirmation action
          // Persist the key and resolve queued requests after a brief delay
          localStorage.setItem('openAIAPIKey', input);
          resolve(input);
          this.pendingOpenAIKeyPromise = null;
        },
        () => {
          // Cancel action
          resolve(null);
          this.pendingOpenAIKeyPromise = null;
        },
        (input: string) => {
          // Input validation action
          // Validate API key before accepting
          return this.browserAPIManager.validateOpenAIAPIKey(input);
        }
      );
    });

    return this.pendingOpenAIKeyPromise;
  }

  async allChildrenUpdateComplete() {
    await this.updateComplete;

    const promises: Promise<void>[] = [];
    const elements = this.shadowRoot?.querySelectorAll<EuphonyConversation>(
      'euphony-conversation'
    );
    if (elements) {
      elements.forEach(element => {
        promises.push(element.allChildrenUpdateComplete());
      });
    }

    await Promise.all(promises);
  }

  scrollToTop = (top = 0, behavior: 'instant' | 'smooth' = 'instant') => {
    this.allChildrenUpdateComplete().then(
      () => {
        const appElement = this.shadowRoot?.querySelector('.app');
        if (appElement) {
          setTimeout(() => {
            appElement.scrollTo({ top, behavior: behavior });
          }, 0);
        }
      },
      () => {}
    );
  };

  scrollToBottom = (behavior: 'instant' | 'smooth' = 'instant') => {
    this.allChildrenUpdateComplete().then(
      () => {
        const appElement = this.shadowRoot?.querySelector('.app');
        if (appElement) {
          setTimeout(() => {
            appElement.scrollTo({
              top: appElement.scrollHeight,
              behavior: behavior
            });
          }, 0);
        }
      },
      () => {}
    );
  };

  scrollToConversation = (
    conversationID: string,
    behavior: 'instant' | 'smooth' = 'smooth'
  ) => {
    const element = this.shadowRoot?.querySelector<HTMLElement>(
      `div${conversationID}`
    );
    const TOP_OFFSET = 20;

    if (element) {
      // Need to skip the header height
      const headerElement = this.shadowRoot?.querySelector('.header');
      const appElement = this.shadowRoot?.querySelector('.app');
      if (!headerElement || !appElement) {
        throw Error('Header element or app element not found');
      }
      const headerHeight = headerElement.getBoundingClientRect().height;
      const elementTop =
        element.getBoundingClientRect().top + appElement.scrollTop;
      const newTop = elementTop - headerHeight - TOP_OFFSET;

      // Focus the element and scroll to it
      element.focus();
      appElement.scrollTo({ top: newTop, behavior: behavior });
    }
  };

  scrollToMessage = (
    conversationID: string,
    messageIndex: number,
    behavior: 'instant' | 'smooth' = 'smooth'
  ) => {
    const element = this.shadowRoot?.querySelector<HTMLElement>(
      `div${conversationID}`
    );
    if (element) {
      const conversationElement = element.querySelector<EuphonyConversation>(
        'euphony-conversation'
      );

      if (!conversationElement) {
        console.error('Conversation element not found');
        return;
      }

      const targetMessageElement =
        conversationElement.getMessageByIndex(messageIndex);

      if (!targetMessageElement) {
        console.error('Target message element not found');
        return;
      }

      const top =
        targetMessageElement.getBoundingClientRect().top +
        window.scrollY -
        HEADER_HEIGHT;

      if (top) {
        this.scrollToTop(top, behavior);
        // Focus the sibling of targetMessageElement (message info)
        const siblingElement =
          targetMessageElement.previousElementSibling as HTMLElement | null;
        if (siblingElement) {
          siblingElement.focus();
        } else {
          console.warn('No sibling element to focus');
        }
      }
    }
  };

  /**
   * Validate and transform the conversations
   * Transform the conversation id from `conversation_id` to `id` if it exists
   *
   * @param conversations - The conversations to validate and transform
   * @returns The validated and transformed conversations
   */
  validateAndTransformConversations = (
    conversations: (string | Conversation | Record<string, unknown>)[]
  ) => {
    const _validateConversation = (conversation: Record<string, unknown>) => {
      return Array.isArray(conversation.messages);
    };

    try {
      const allValid: boolean[] = [];
      for (const [i, conversation] of conversations.entries()) {
        if (typeof conversation === 'string') {
          const conversationData = JSON.parse(conversation) as Record<
            string,
            unknown
          >;
          let newItem = conversation;

          // Special handling for chatgpt web's harmony dialect, where people
          // use `conversation_id` instead of `id`
          if (
            conversationData.conversation_id !== undefined &&
            conversationData.id === undefined
          ) {
            conversationData.id = conversationData.conversation_id;
            newItem = JSON.stringify(conversationData);
          }

          conversations[i] = newItem;
          allValid.push(_validateConversation(conversationData));
        } else {
          const conversationData = conversation as unknown as Record<
            string,
            unknown
          >;

          // Special handling for a Harmony dialect that uses
          // `conversation_id` instead of `id`.
          if (
            conversationData.conversation_id !== undefined &&
            conversationData.id === undefined
          ) {
            conversationData.id = conversationData.conversation_id;
          }

          conversations[i] = conversationData;
          allValid.push(_validateConversation(conversationData));
        }
      }

      return allValid.every(valid => valid);
    } catch (error) {
      console.error('Bad conversation format', error);
      return false;
    }
  };

  validateConversation = (
    conversation: string | Conversation | Record<string, unknown>
  ) => {
    const _validateConversation = (conversation: Record<string, unknown>) => {
      return Array.isArray(conversation.messages);
    };

    try {
      if (typeof conversation === 'string') {
        const conversationData = JSON.parse(conversation) as Record<
          string,
          unknown
        >;
        return _validateConversation(conversationData);
      } else {
        const conversationData = conversation as unknown as Record<
          string,
          unknown
        >;
        return _validateConversation(conversationData);
      }
    } catch (error) {
      console.error('Bad conversation format', error);
      return false;
    }
  };

  validateComparison = (
    comparison: string | Conversation | Record<string, unknown>
  ) => {
    const _validateComparison = (comparison: Record<string, unknown>) => {
      return (
        comparison.conversation !== undefined &&
        comparison.completions !== undefined
      );
    };

    try {
      if (typeof comparison === 'string') {
        const comparisonData = JSON.parse(comparison) as Record<
          string,
          unknown
        >;
        return _validateComparison(comparisonData);
      } else {
        const comparisonData = comparison as unknown as Record<string, unknown>;
        return _validateComparison(comparisonData);
      }
    } catch (error) {
      console.error('Bad comparison format', error);
      return false;
    }
  };

  loadDataFromText = (sourceText: string, sourceName: 'clipboard' | 'file') => {
    this.isLocalCodexBrowserMode = false;
    this.curPage = 1;
    this.resetHash();
    const requestID = this.localDataWorkerRequestID;
    this.activeLocalDataWorkerRequestID = requestID;

    return new Promise<void>((resolve, reject) => {
      this.localDataWorkerPendingRequests.set(requestID, { resolve, reject });
      const message: LocalDataWorkerMessage = {
        command: 'startParseData',
        payload: {
          requestID,
          sourceName,
          sourceText
        }
      };
      this.localDataWorker.postMessage(message);
    });
  };

  loadDataFromFile = (sourceFile: File) => {
    this.isLocalCodexBrowserMode = false;
    this.curPage = 1;
    this.resetHash();
    const requestID = this.localDataWorkerRequestID;
    this.activeLocalDataWorkerRequestID = requestID;

    return new Promise<void>((resolve, reject) => {
      this.localDataWorkerPendingRequests.set(requestID, { resolve, reject });
      const message: LocalDataWorkerMessage = {
        command: 'startParseData',
        payload: {
          requestID,
          sourceName: 'file',
          sourceFile
        }
      };
      this.localDataWorker.postMessage(message);
    });
  };

  localDataWorkerMessageHandler(e: MessageEvent<LocalDataWorkerMessage>) {
    switch (e.data.command) {
      case 'finishParseData': {
        const { requestID, sourceName, dataType } = e.data.payload;
        const pendingRequest =
          this.localDataWorkerPendingRequests.get(requestID);
        this.localDataWorkerPendingRequests.delete(requestID);
        if (requestID !== this.activeLocalDataWorkerRequestID) {
          pendingRequest?.resolve();
          break;
        }
        blobPath = null;
        this.isLoadingData = false;

        this.codexSessionData = [];
        this.allConversationData = [];
        this.conversationData = [];
        this.JSONData = [];

        if (dataType === 'codex') {
          this.codexSessionData = [e.data.payload.codexSessionData];
          this.selectedConversationIDs = new Set();
          this.dataType = DataType.CODEX;
          this._totalConversationSize = 1;
          this._totalConversationSizeIncludingUnfiltered = 1;
          this.isLoadingFromCache = false;
          this.isLoadingFromClipboard = true;

          this.toastMessage = `Codex session loaded successfully from ${sourceName}`;
          this.toastType = 'success';
        } else if (dataType === 'json') {
          this.JSONData = e.data.payload.jsonData;
          this.dataType = DataType.JSON;
          this._totalConversationSize = this.JSONData.length;
          this._totalConversationSizeIncludingUnfiltered = this.JSONData.length;
          this.isLoadingFromCache = false;
          this.isLoadingFromClipboard = true;

          this.toastMessage =
            'Failed to find harmony-formatted data. Render JSON instead.';
          this.toastType = 'warning';
        } else {
          const conversationData = e.data.payload.conversationData;
          this._totalConversationSize = conversationData.length;
          this._totalConversationSizeIncludingUnfiltered =
            conversationData.length;

          if (this.isEditorMode) {
            this.selectedConversationIDs = new Set();
            for (let i = 0; i < conversationData.length; i++) {
              this.selectedConversationIDs.add(i);
            }
          }

          this.allConversationData = conversationData;
          this.conversationData = this.isEditorMode
            ? conversationData
            : conversationData.slice(
                (this.curPage - 1) * this.itemsPerPage,
                this.curPage * this.itemsPerPage
              );
          this.dataType = DataType.CONVERSATION;
          this.isLoadingFromCache = false;
          this.isLoadingFromClipboard = true;

          this.toastMessage = `Data loaded successfully from ${sourceName}`;
          this.toastType = 'success';
        }

        this.toastComponent?.show();
        pendingRequest?.resolve();
        break;
      }

      case 'error': {
        const { requestID, sourceName, message } = e.data.payload;
        const pendingRequest =
          this.localDataWorkerPendingRequests.get(requestID);
        this.localDataWorkerPendingRequests.delete(requestID);
        if (requestID !== this.activeLocalDataWorkerRequestID) {
          pendingRequest?.reject(new Error(message));
          break;
        }
        this.isLoadingData = false;

        this.toastMessage =
          `Failed to read any JSON or JSONL data from your ${sourceName}. ` +
          `Please double check and try again.\n\n${message}`;
        this.toastType = 'error';
        this.toastComponent?.show();
        pendingRequest?.reject(new Error(message));
        break;
      }

      default: {
        console.error('Unknown local data worker message', e.data.command);
        break;
      }
    }
  }

  localFileInputChanged(e: Event) {
    const inputElement = e.target as HTMLInputElement;
    const file = inputElement.files?.[0];
    if (!file) {
      return;
    }

    this.isLoadingData = true;
    this.loadDataFromFile(file)
      .catch((error: unknown) => {
        this.toastMessage = `Failed to read local file.\n\n${error}`;
        this.toastType = 'error';
        this.toastComponent?.show();
        this.isLoadingData = false;
      })
      .finally(() => {
        inputElement.value = '';
      });
  }

  localCodexProjectClicked(projectId: string) {
    if (projectId === '' || projectId === this.selectedLocalCodexProjectId) {
      return;
    }

    this.loadLocalCodexProjectSessions(projectId).then(
      () => {},
      () => {}
    );
  }

  localCodexSessionClicked(session: CodexSessionSummary) {
    this.openLocalCodexSession(session).then(
      () => {},
      () => {}
    );
  }

  async openLocalCodexSession(
    session: CodexSessionSummary,
    shouldScrollToDetail = true
  ) {
    const requestID = this.localCodexSessionRequestCount++;
    this.activeLocalCodexSessionRequestID = requestID;
    this.isLocalCodexBrowserMode = true;
    this.isLoadingLocalCodexSession = true;
    this.selectedLocalCodexSessionId = session.id;
    this.localCodexDetailErrorMessage = '';
    this.clearRenderedData();
    this.isLoadingFromCache = false;
    this.isLoadingFromClipboard = false;

    const detailState = await loadLocalCodexSessionDetail(
      this.apiManager,
      session
    );

    if (requestID !== this.activeLocalCodexSessionRequestID) {
      return;
    }

    this.selectedLocalCodexSessionId = detailState.selectedSessionId;
    this.localCodexDetailErrorMessage = detailState.errorMessage;
    this.codexSessionData =
      detailState.sessionData.length > 0 ? [detailState.sessionData] : [];
    this.allConversationData = [];
    this.conversationData = [];
    this.JSONData = [];
    this.selectedConversationIDs = new Set();
    this.dataType = DataType.CODEX;
    this._totalConversationSize = this.codexSessionData.length;
    this._totalConversationSizeIncludingUnfiltered =
      this.codexSessionData.length;
    this.isLoadingFromCache = false;
    this.isLoadingFromClipboard = false;
    this.isLoadingLocalCodexSession = false;

    if (shouldScrollToDetail && this.codexSessionData.length > 0) {
      await this.updateComplete;
      this.scrollToConversation('#conversation-0');
    }
  }

  renderLocalCodexBrowser(conversationsTemplate: TemplateResult) {
    const selectedProject = this.localCodexProjects.find(
      project => project.id === this.selectedLocalCodexProjectId
    );
    const selectedSession = this.localCodexSessions.find(
      session => session.id === this.selectedLocalCodexSessionId
    );
    const sessionTree = buildLocalCodexSessionTree(this.localCodexSessions);
    const sessionSearchQuery = this.localCodexSessionSearchQuery.trim();
    const isSessionSearchActive = sessionSearchQuery !== '';
    const sessionSearchResult = filterLocalCodexSessionTree(
      sessionTree,
      sessionSearchQuery
    );
    const sessionRowsTree = sessionSearchResult.treeItems;
    const expandedSessionIdsForDisplay = new Set(
      this.expandedLocalCodexParentSessionIDs
    );
    if (isSessionSearchActive) {
      for (const parentSessionId of sessionSearchResult.autoExpandedParentSessionIds) {
        expandedSessionIdsForDisplay.add(parentSessionId);
      }
    }
    const visibleSessionIds = getVisibleLocalCodexSessionIds(
      sessionRowsTree,
      expandedSessionIdsForDisplay
    );
    const selectableSessionIds = isSessionSearchActive
      ? [...sessionSearchResult.matchedSessionIds]
      : visibleSessionIds;
    const selectableSessionIdSet = new Set(selectableSessionIds);
    const selectedVisibleSessionIds = [
      ...this.selectedLocalCodexSessionIDs
    ].filter(sessionId => selectableSessionIdSet.has(sessionId));
    const selectedSessionCount = selectedVisibleSessionIds.length;
    const allSessionsSelected =
      selectedSessionCount > 0 &&
      selectedSessionCount === selectableSessionIds.length;
    const sessionCountText = isSessionSearchActive
      ? `${NUM_FORMATTER(sessionSearchResult.matchedSessionIds.size)} of ${NUM_FORMATTER(
          this.localCodexSessions.length
        )} sessions`
      : `${NUM_FORMATTER(this.localCodexSessions.length)} sessions`;

    const projectOptions = this.localCodexProjects.map(
      project => html`
        <option
          value=${project.id}
          ?selected=${project.id === this.selectedLocalCodexProjectId}
        >
          ${project.name} (${NUM_FORMATTER(project.sessionCount)})
        </option>
      `
    );

    const childSummaryText = (children: CodexSessionSummary[]): string => {
      if (children.length === 0) {
        return '';
      }

      const childCountText = `${NUM_FORMATTER(children.length)} subagent${
        children.length === 1 ? '' : 's'
      }`;
      const nicknames = [
        ...new Set(
          children
            .map(child => child.agentNickname)
            .filter((nickname): nickname is string => nickname !== null)
        )
      ];
      if (nicknames.length === 0) {
        return childCountText;
      }

      const visibleNicknames = nicknames.slice(0, 3).join(', ');
      const hiddenNicknameCount = nicknames.length - 3;
      return hiddenNicknameCount > 0
        ? `${childCountText}: ${visibleNicknames}, +${NUM_FORMATTER(hiddenNicknameCount)} more`
        : `${childCountText}: ${visibleNicknames}`;
    };

    const renderSessionRow = ({
      session,
      children = [],
      isChild = false,
      isOrphanSubagent = false,
      isSelectable = true
    }: {
      session: CodexSessionSummary;
      children?: CodexSessionSummary[];
      isChild?: boolean;
      isOrphanSubagent?: boolean;
      isSelectable?: boolean;
    }) => {
      const sessionTimestamp = session.updatedAt ?? session.createdAt ?? null;
      const hasChildren = children.length > 0;
      const isExpanded = expandedSessionIdsForDisplay.has(session.id);
      const childrenListId = `local-codex-session-children-${session.id}`;
      const sessionIsSubagent = isLocalCodexSubagentSession(session);
      const selectionDisabled =
        !isSelectable ||
        this.isLoadingData ||
        this.isDeletingLocalCodexSessions;
      return html`
        <div
          class=${`local-codex-session-row${
            isChild ? ' local-codex-session-child-row' : ''
          }`}
        >
          ${hasChildren
            ? html`
                <button
                  class="local-codex-session-expand-button"
                  type="button"
                  aria-controls=${childrenListId}
                  aria-expanded=${isExpanded ? 'true' : 'false'}
                  aria-label=${`${isExpanded ? 'Collapse' : 'Expand'} subagents for ${session.title}`}
                  ?disabled=${this.isLoadingData ||
                  this.isDeletingLocalCodexSessions ||
                  isSessionSearchActive}
                  @click=${() => {
                    this.toggleLocalCodexParentSessionExpansion(
                      session.id,
                      children.map(child => child.id)
                    );
                  }}
                >
                  <span class="svg-icon icon"
                    >${unsafeHTML(iconChevronUpSm)}</span
                  >
                </button>
              `
            : html`<span class="local-codex-session-expand-spacer"></span>`}
          <input
            class="local-codex-session-checkbox"
            id=${`local-codex-session-select-${session.id}`}
            name=${`local-codex-session-select-${session.id}`}
            type="checkbox"
            .checked=${isSelectable &&
            this.selectedLocalCodexSessionIDs.has(session.id)}
            ?disabled=${selectionDisabled}
            aria-label=${`Select session ${session.title}`}
            @change=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              this.toggleLocalCodexSessionSelection(session.id, target.checked);
            }}
          />
          <button
            class="local-codex-session-content"
            ?is-selected=${session.id === this.selectedLocalCodexSessionId}
            ?is-child=${isChild}
            ?disabled=${this.isLoadingData || this.isDeletingLocalCodexSessions}
            @click=${() => {
              this.localCodexSessionClicked(session);
            }}
          >
            <span class="local-codex-session-main">
              <span class="local-codex-session-title-line">
                ${session.agentNickname
                  ? html`<span class="local-codex-agent-nickname"
                      >${session.agentNickname}</span
                    >`
                  : ''}
                <span class="local-codex-session-title">${session.title}</span>
              </span>
              <span class="local-codex-session-preview"
                >${session.preview}</span
              >
              ${hasChildren
                ? html`<span class="local-codex-session-child-summary"
                    >${childSummaryText(children)}</span
                  >`
                : ''}
              <span class="local-codex-session-path"
                >${session.cwd ?? 'Unknown project'}</span
              >
            </span>
            <span class="local-codex-session-meta">
              ${sessionIsSubagent
                ? html`<span class="local-codex-subagent">Subagent</span>`
                : ''}
              ${isOrphanSubagent
                ? html`<span class="local-codex-orphan-subagent">Orphan</span>`
                : ''}
              ${session.archived
                ? html`<span class="local-codex-archived">Archived</span>`
                : ''}
              <time datetime=${ifDefined(sessionTimestamp ?? undefined)}
                >${formatLocalCodexTimestamp(sessionTimestamp)}</time
              >
            </span>
          </button>
        </div>
      `;
    };

    const renderSessionItem = (item: LocalCodexSessionTreeItem) => {
      const isExpanded = expandedSessionIdsForDisplay.has(item.session.id);
      const childrenListId = `local-codex-session-children-${item.session.id}`;
      return html`
        <li class="local-codex-session-item">
          ${renderSessionRow({
            session: item.session,
            children: item.children,
            isOrphanSubagent: item.isOrphanSubagent,
            isSelectable:
              !isSessionSearchActive ||
              sessionSearchResult.matchedSessionIds.has(item.session.id)
          })}
          ${item.children.length > 0 && isExpanded
            ? html`
                <ul class="local-codex-session-child-list" id=${childrenListId}>
                  ${item.children.map(
                    child => html`
                      <li class="local-codex-session-child-item">
                        ${renderSessionRow({
                          session: child,
                          isChild: true,
                          isSelectable:
                            !isSessionSearchActive ||
                            sessionSearchResult.matchedSessionIds.has(child.id)
                        })}
                      </li>
                    `
                  )}
                </ul>
              `
            : ''}
        </li>
      `;
    };

    const sessionRows = sessionRowsTree.map(renderSessionItem);

    const warningRows = this.localCodexWarnings.map(
      warning => html`<li>${warning}</li>`
    );

    const selectedSessionTimestamp = selectedSession
      ? (selectedSession.updatedAt ?? selectedSession.createdAt ?? null)
      : null;
    const selectedSessionMeta = selectedSession
      ? html`
          <span class="local-codex-detail-meta">
            ${isLocalCodexSubagentSession(selectedSession)
              ? html`<span class="local-codex-subagent">Subagent</span>`
              : ''}
            ${selectedSession.agentNickname
              ? html`<span class="local-codex-agent-nickname"
                  >${selectedSession.agentNickname}</span
                >`
              : ''}
            ${selectedSession.archived
              ? html`<span class="local-codex-archived">Archived</span>`
              : ''}
            <time datetime=${ifDefined(selectedSessionTimestamp ?? undefined)}
              >${formatLocalCodexTimestamp(selectedSessionTimestamp)}</time
            >
            <span class="local-codex-detail-actions">
              <sl-copy-button
                class="local-codex-detail-copy-button"
                .value=${selectedSession.rolloutPath}
                ?disabled=${this.isLoadingData ||
                this.isDeletingLocalCodexSessions}
                copy-label="Copy session file path"
                success-label="Session file path copied"
                error-label="Failed to copy session file path"
                hoist
              >
                <sl-icon
                  slot="copy-icon"
                  library="system"
                  name="copy"
                  aria-hidden="true"
                ></sl-icon>
                <span
                  slot="copy-icon"
                  class="local-codex-detail-copy-assistive-text"
                  >Copy session file path</span
                >
              </sl-copy-button>
              <button
                class="button local-codex-detail-delete-button"
                ?disabled=${this.isLoadingData ||
                this.isDeletingLocalCodexSessions}
                @click=${() => {
                  this.promptLocalCodexSessionDeletion(
                    [selectedSession.id],
                    `"${selectedSession.title}" (${selectedSession.id})`
                  );
                }}
              >
                <span class="svg-icon icon">${unsafeHTML(iconTrash)}</span>
                Delete session
              </button>
            </span>
          </span>
        `
      : html`
          <span class="local-codex-detail-meta">No session selected</span>
        `;

    let bodyTemplate = html``;
    if (this.localCodexErrorMessage !== '') {
      bodyTemplate = html`
        <div class="local-codex-state-message" role="alert">
          ${this.localCodexErrorMessage}
        </div>
      `;
    } else if (this.localCodexProjects.length === 0) {
      bodyTemplate = html`
        <div class="local-codex-state-message" role="status">
          No local Codex sessions found.
        </div>
      `;
    } else {
      const detailContentTemplate =
        this.localCodexDetailErrorMessage !== ''
          ? html`
              <div class="local-codex-detail-error" role="alert">
                ${this.localCodexDetailErrorMessage}
              </div>
            `
          : this.isLoadingLocalCodexSession
            ? html`
                <div class="local-codex-detail-status" role="status">
                  Loading selected session.
                </div>
              `
            : this.codexSessionData.length > 0
              ? html`
                  <div class="local-codex-rendered-session">
                    <div
                      class="conversation-list"
                      ?is-grid-view=${this.isGridView}
                    >
                      ${conversationsTemplate}
                    </div>
                  </div>
                `
              : html`
                  <div class="local-codex-detail-empty" role="status">
                    Select a session to view its Codex rollout.
                  </div>
                `;

      bodyTemplate = html`
        <div class="local-codex-master-detail">
          <section
            class="local-codex-master"
            aria-label="Codex projects and sessions"
          >
            <div class="local-codex-project-picker">
              <label for="local-codex-project-select">Project</label>
              <div class="local-codex-project-select-wrapper">
                <select
                  id="local-codex-project-select"
                  .value=${this.selectedLocalCodexProjectId ?? ''}
                  ?disabled=${this.isLoadingData ||
                  this.isDeletingLocalCodexSessions}
                  @change=${(e: Event) => {
                    const target = e.target as HTMLSelectElement;
                    this.localCodexProjectClicked(target.value);
                  }}
                >
                  ${projectOptions}
                </select>
              </div>
              <p class="local-codex-project-summary">
                ${selectedProject?.path ??
                selectedProject?.id ??
                'Select a project'}
              </p>
            </div>

            <div class="local-codex-session-section">
              <div class="local-codex-section-header">
                <div>
                  <h2>Sessions</h2>
                  <p>${selectedProject?.name ?? 'Select a project'}</p>
                </div>
                <span>${sessionCountText}</span>
              </div>
              <div class="local-codex-session-search">
                <label for="local-codex-session-search-input">
                  Search sessions
                </label>
                <div class="local-codex-session-search-control">
                  <input
                    id="local-codex-session-search-input"
                    type="search"
                    .value=${this.localCodexSessionSearchQuery}
                    placeholder="Title, preview, path, nickname, ID"
                    ?disabled=${this.isLoadingData ||
                    this.isDeletingLocalCodexSessions}
                    @input=${(e: Event) => {
                      this.localCodexSessionSearchInput(e);
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      e.stopPropagation();
                    }}
                  />
                  <button
                    class="button local-codex-session-search-clear-button"
                    aria-label="Clear session search"
                    ?disabled=${this.isLoadingData ||
                    this.isDeletingLocalCodexSessions ||
                    this.localCodexSessionSearchQuery === ''}
                    @click=${() => {
                      this.clearLocalCodexSessionSearch();
                    }}
                  >
                    <span class="svg-icon icon">${unsafeHTML(iconClose)}</span>
                  </button>
                </div>
              </div>
              <div class="local-codex-session-actions">
                <span class="local-codex-session-selection-status">
                  ${selectedSessionCount > 0
                    ? `${NUM_FORMATTER(selectedSessionCount)} selected`
                    : 'No sessions selected'}
                </span>
                <div class="local-codex-session-action-buttons">
                  <button
                    class="button local-codex-session-select-button"
                    ?disabled=${this.isLoadingData ||
                    this.isDeletingLocalCodexSessions ||
                    selectableSessionIds.length === 0}
                    @click=${() => {
                      this.toggleSelectAllLocalCodexSessions();
                    }}
                  >
                    ${allSessionsSelected ? 'Clear selection' : 'Select all'}
                  </button>
                  <button
                    class="button local-codex-session-delete-button"
                    ?disabled=${this.isLoadingData ||
                    this.isDeletingLocalCodexSessions ||
                    selectedSessionCount === 0}
                    @click=${() => {
                      this.promptLocalCodexSessionDeletion(
                        selectedVisibleSessionIds,
                        `${NUM_FORMATTER(selectedSessionCount)} selected session${
                          selectedSessionCount === 1 ? '' : 's'
                        }`
                      );
                    }}
                  >
                    <span class="svg-icon icon">${unsafeHTML(iconTrash)}</span>
                    Delete selected
                  </button>
                </div>
              </div>
              ${this.localCodexSessionsErrorMessage !== ''
                ? html`
                    <div class="local-codex-detail-error" role="alert">
                      ${this.localCodexSessionsErrorMessage}
                    </div>
                  `
                : this.localCodexSessions.length === 0
                  ? html`
                      <div class="local-codex-state-message" role="status">
                        ${this.isLoadingLocalCodexSessions
                          ? 'Loading sessions for this project.'
                          : 'No sessions found for this project.'}
                      </div>
                    `
                  : isSessionSearchActive &&
                      sessionSearchResult.matchedSessionIds.size === 0
                    ? html`
                        <div class="local-codex-state-message" role="status">
                          No sessions match "${sessionSearchQuery}".
                        </div>
                      `
                    : html`<ul class="local-codex-session-list">
                        ${sessionRows}
                      </ul>`}
            </div>
          </section>

          <section class="local-codex-detail" aria-label="Codex session detail">
            <div class="local-codex-detail-header">
              <div>
                <h2>${selectedSession?.title ?? 'Session detail'}</h2>
                <p>
                  ${selectedSession?.preview ??
                  'Select a session to view its Codex rollout.'}
                </p>
              </div>
              ${selectedSessionMeta}
            </div>
            ${detailContentTemplate}
          </section>
        </div>
      `;
    }

    return html`
      <div class="local-codex-browser">
        <div class="local-codex-browser-header">
          <div>
            <h1>Local Codex Sessions</h1>
            <p>
              Browse sessions grouped by project from your local Codex home.
            </p>
          </div>
          <button
            class="button local-codex-refresh-button"
            ?disabled=${this.isLoadingData || this.isDeletingLocalCodexSessions}
            @click=${() => {
              this.refreshLocalCodexSessions(
                this.selectedLocalCodexProjectId,
                true
              ).then(
                () => {},
                () => {}
              );
            }}
          >
            Refresh
          </button>
        </div>
        ${this.localCodexWarnings.length > 0
          ? html`<ul class="local-codex-warnings">
              ${warningRows}
            </ul>`
          : ''}
        ${bodyTemplate}
      </div>
    `;
  }

  loadData = async ({
    blobURL,
    offset,
    limit,
    showSuccessToast = true,
    noCache = false,
    jmespathQuery = ''
  }: {
    blobURL: string;
    offset: number;
    limit: number;
    showSuccessToast?: boolean;
    noCache?: boolean;
    jmespathQuery?: string;
  }): Promise<{
    isLoadDataSuccessful: boolean;
    loadDataMessage: string;
    loadedURL: string;
  }> => {
    this.isLoadingData = true;
    this.isLocalCodexBrowserMode = false;
    this.isLoadingFromClipboard = false;
    this.codexSessionData = [];
    let loadedURL = blobURL;
    const toastMessages = [];

    try {
      const curAPIManager = this.isFrontendOnlyMode
        ? this.browserAPIManager
        : this.apiManager;

      const { data, total, matchedCount, resolvedURL } =
        await curAPIManager.getJSONL({
          blobURL,
          offset,
          limit,
          noCache,
          jmespathQuery
        });

      loadedURL = resolvedURL;

      if (data.length === 0) {
        this.isLoadingData = false;
        toastMessages.push('No data found.');
        return {
          isLoadDataSuccessful: false,
          loadDataMessage: toastMessages.join('\n\n'),
          loadedURL: loadedURL
        };
      }

      // We know the data is successfully loaded, so we update the URL state
      // early before any follow-up rendering or pagination work.
      blobPath = blobURL;

      // Codex sessions are JSONL event streams, not Harmony conversations.
      // Fetch the full event stream if the first page was truncated and route
      // the result to the Codex renderer.
      if (isCodexSessionJSONL(data as unknown[])) {
        let codexSessionEvents = data as unknown[];
        if (total > data.length) {
          const fullResponse = await curAPIManager.getJSONL({
            blobURL,
            offset: 0,
            limit: total,
            noCache,
            jmespathQuery
          });
          codexSessionEvents = fullResponse.data as unknown[];
        }

        this.codexSessionData = [codexSessionEvents];
        this.allConversationData = [];
        this.conversationData = [];
        this.JSONData = [];
        this.selectedConversationIDs = new Set();
        this.dataType = DataType.CODEX;
        this._totalConversationSize = 1;
        this._totalConversationSizeIncludingUnfiltered = 1;
        this.isLoadingData = false;
        this.isLoadingFromCache = !noCache;

        if (urlHash === '') {
          this.scrollToTop(0);
        }

        if (showSuccessToast) {
          toastMessages.push('Codex session loaded successfully');
          this.toastMessage = toastMessages.join('\n\n');
          this.toastType = 'success';
          if (this.toastComponent) {
            this.toastComponent.show();
          }
        }

        return {
          isLoadDataSuccessful: true,
          loadDataMessage: toastMessages.join('\n\n'),
          loadedURL: loadedURL
        };
      }

      // Check if the data is valid
      if (!this.validateConversation(data[0])) {
        // If data is invalid conversation, we render it as JSON
        toastMessages.push(
          'Failed to find harmony-formatted data. Render JSON instead.'
        );
        this.toastMessage = toastMessages.join('\n\n');
        this.toastType = 'warning';
        if (this.toastComponent) {
          this.toastComponent.show();
        }
        this.isLoadingData = false;

        // If there is no hash in the url, scroll to top after loading data
        if (urlHash === '') {
          this.scrollToTop(0);
        }

        const typedData = data as Record<string, unknown>[];
        this.JSONData = typedData;
        this.dataType = DataType.JSON;
        this._totalConversationSize = matchedCount;
        this._totalConversationSizeIncludingUnfiltered = total;

        toastMessages.push(`Loaded ${matchedCount} conversations`);
        return {
          isLoadDataSuccessful: true,
          loadDataMessage: toastMessages.join('\n\n'),
          loadedURL: loadedURL
        };
      }

      this._totalConversationSize = matchedCount;
      this._totalConversationSizeIncludingUnfiltered = total;

      // Set all the conversations as selected in editor mode
      if (this.isEditorMode) {
        this.selectedConversationIDs = new Set();
        for (let i = 0; i < data.length; i++) {
          this.selectedConversationIDs.add(i);
        }
      }

      // Conversation
      // - Conversation string
      if (typeof data[0] === 'string') {
        const newData: Conversation[] = data.map(item => {
          if (typeof item === 'string') {
            const parsed = parseConversationJSONString(item);
            if (parsed === null) {
              throw new Error('Failed to parse conversation JSON string');
            }
            return parsed;
          }
          return item as Conversation;
        });
        this.allConversationData = newData;
        this.conversationData = newData;
        this.dataType = DataType.CONVERSATION;
      } else {
        // - Conversation object
        const typedData = data as Conversation[];
        this.allConversationData = typedData;
        this.conversationData = typedData;
        this.dataType = DataType.CONVERSATION;
      }

      this.isLoadingData = false;

      // If there is no hash in the url, scroll to top after loading data
      if (urlHash === '') {
        this.scrollToTop(0);
      }

      console.log(`Loaded ${limit} conversations`);

      // Update the cache info
      this.isLoadingFromCache = !noCache;

      // Show a successful toast
      if (showSuccessToast) {
        toastMessages.push('Data loaded successfully');
        this.toastMessage = toastMessages.join('\n\n');
        this.toastType = 'success';
        if (this.toastComponent) {
          this.toastComponent.show();
        }
      }
      return {
        isLoadDataSuccessful: true,
        loadDataMessage: toastMessages.join('\n\n'),
        loadedURL: loadedURL
      };
    } catch (error) {
      console.error('Error loading data', error);
      // Show a failure toast
      let errorMessage = `Failed to load the data.\n\n${error}`;
      if (blobURL.includes(' ')) {
        errorMessage +=
          '\n\nMake sure the URL has no spaces or invalid characters.';
      } else {
        errorMessage +=
          '\n\nMake sure the URL is correct and publicly reachable.';
      }

      toastMessages.push(errorMessage);
      this.toastMessage = toastMessages.join('\n\n');
      this.toastType = 'error';
      if (this.toastComponent) {
        this.toastComponent.show();
      }

      this.isLoadingData = false;
      return {
        isLoadDataSuccessful: false,
        loadDataMessage: toastMessages.join('\n\n'),
        loadedURL: loadedURL
      };
    }
  };

  resetFilter = async (filter: 'jmespath' | 'concept') => {
    if (blobPath === null) {
      throw Error('Blob path is not set');
    }

    if (filter === 'jmespath') {
      this.jmespathQuery = '';
    }
    this.curPage = 1;
    let noCache = false;
    if (this.noCacheBlobPaths.has(blobPath)) {
      noCache = true;
    } else {
      noCache = urlParams.get('no-cache') === 'true';
    }

    await this.loadData({
      blobURL: blobPath,
      offset: (this.curPage - 1) * this.itemsPerPage,
      limit: this.itemsPerPage,
      showSuccessToast: false,
      noCache,
      jmespathQuery: this.jmespathQuery
    });

    this.urlManager.updateURL();
  };

  resetHash = () => {
    // Remove the hash from the URL but keep the search parameters
    const url = new URL(window.location.href);
    url.hash = '';
    urlHash = '';
    url.searchParams.delete('index');
    conversationIndex = null;
    history.pushState({}, '', url.toString());

    // Remove the focus from the active element
    if (this.shadowRoot?.activeElement) {
      (this.shadowRoot.activeElement as HTMLElement).blur();
    }
  };

  buildEuphonyStyle(styleConfig: Record<string, string>) {
    let style = '';
    for (const [key, value] of Object.entries(styleConfig)) {
      style += `${key}: ${value};`;
    }
    return style;
  }

  //==========================================================================||
  //                           Templates and Styles                           ||
  //==========================================================================||
  getConversationViewerElements(): ConversationViewerElement[] {
    return [
      ...(this.shadowRoot?.querySelectorAll<EuphonyConversation>(
        'euphony-conversation'
      ) ?? []),
      ...(this.shadowRoot?.querySelectorAll<EuphonyCodex>('euphony-codex') ??
        [])
    ];
  }

  render() {
    // Build the conversation components
    let conversationsTemplate = html``;

    let conversationList:
      | Conversation[]
      | Record<string, unknown>[]
      | unknown[][];

    // Use a switch statement to set conversationList based on dataType
    switch (this.dataType) {
      case DataType.CONVERSATION:
        conversationList = this.conversationData;
        break;
      case DataType.CODEX:
        conversationList = this.codexSessionData;
        break;
      case DataType.JSON:
        conversationList = this.JSONData;
        break;
    }

    for (const [i, conversation] of conversationList.entries()) {
      const curID = (this.curPage - 1) * this.itemsPerPage + i;
      const url = this.urlManager.getShareURL(curID, blobPath);

      let euphonyTemplate = html``;

      if (this.dataType === DataType.CONVERSATION) {
        // Handle the case where the conversation is a string
        // (double string encoding during JSON serialization)
        let curConversation: Conversation | null = null;
        curConversation = conversation as Conversation;

        euphonyTemplate = html`
          <euphony-conversation
            id="euphony-conversation-${curID}"
            .conversationData=${curConversation}
            conversation-max-width=${ifDefined(
              this.isGridView ? undefined : '800'
            )}
            sharing-url=${ifDefined(
              this.isLoadingFromClipboard ? undefined : url
            )}
            data-file-url=${ifDefined(blobPath ?? undefined)}
            focus-mode-author=${JSON.stringify(this.focusModeAuthor)}
            focus-mode-recipient=${JSON.stringify(this.focusModeRecipient)}
            focus-mode-content-type=${JSON.stringify(this.focusModeContentType)}
            ?is-editable=${this.isEditorMode}
            ?is-showing-metadata=${this.globalIsShowingMetadata}
            ?should-render-markdown=${this.globalShouldRenderMarkdown}
            ?disable-editing-mode-save-button=${true}
            ?disable-preference-button=${true}
            ?disable-image-preview-window=${true}
            ?disable-token-window=${true}
            theme="light"
            style=${this.buildEuphonyStyle(this.euphonyStyleConfig)}
            @refresh-renderer-list-requested=${(
              e: CustomEvent<RefreshRendererListRequest>
            ) => {
              // This is not used, because we use the shared token window under app.ts
              if (this.isFrontendOnlyMode) {
                this.requestWorker
                  .frontendOnlyRefreshRendererListRequestHandler(e)
                  .then(
                    () => {},
                    () => {}
                  );
              } else {
                this.requestWorker.refreshRendererListRequestHandler(e).then(
                  () => {},
                  () => {}
                );
              }
            }}
            @harmony-render-requested=${(
              e: CustomEvent<HarmonyRenderRequest>
            ) => {
              // This is not used, because we use the shared token window under app.ts
              if (this.isFrontendOnlyMode) {
                this.requestWorker
                  .frontendOnlyHarmonyRenderRequestHandler(e)
                  .then(
                    () => {},
                    () => {}
                  );
              } else {
                this.requestWorker.harmonyRenderRequestHandler(e).then(
                  () => {},
                  () => {}
                );
              }
            }}
            @conversation-metadata-button-toggled=${(
              e: CustomEvent<boolean>
            ) => {
              this.conversationMetadataButtonToggled(e).then(
                () => {},
                () => {}
              );
            }}
            @markdown-button-toggled=${(e: CustomEvent<boolean>) => {
              this.markdownButtonToggled(e).then(
                () => {},
                () => {}
              );
            }}
            @translation-requested=${(e: CustomEvent<TranslationRequest>) => {
              if (this.isFrontendOnlyMode) {
                this.ensureOpenAIAPIKey()
                  .then(apiKey => {
                    if (apiKey) {
                      this.requestWorker
                        .frontendOnlyTranslationRequestHandler(e, apiKey)
                        .then(
                          () => {},
                          () => {}
                        );
                    } else {
                      // User cancelled or no key provided; reject to avoid hanging requests
                      e.detail.reject(
                        'OpenAI API key is required for frontend-only translation.'
                      );
                    }
                  })
                  .catch(() => {});
              } else {
                this.requestWorker.translationRequestHandler(e).then(
                  () => {},
                  () => {}
                );
              }
            }}
            @fetch-message-sharing-url=${(
              e: CustomEvent<MessageSharingRequest>
            ) => {
              // Resolve the message's sharing URL
              this.requestWorker.fetchMessageSharingURLRequestHandler(
                e,
                curID,
                this.urlManager,
                blobPath
              );
            }}
            @harmony-render-button-clicked=${(e: CustomEvent<string>) => {
              this.harmonyRenderButtonClicked(e);
            }}
            @convo-deletion-button-clicked=${(e: CustomEvent<boolean>) => {
              const markedForDeletion = e.detail;
              if (markedForDeletion) {
                this.selectedConversationIDs.delete(curID);
              } else {
                this.selectedConversationIDs.add(curID);
              }
              this.requestUpdate();
            }}
          ></euphony-conversation>
        `;
      } else if (this.dataType === DataType.CODEX) {
        const curCodexSession = conversation as unknown[];
        euphonyTemplate = html`
          <euphony-codex
            id="euphony-conversation-${curID}"
            .sessionData=${curCodexSession}
            conversation-label="Session"
            conversation-max-width=${ifDefined(
              this.isGridView ? undefined : '800'
            )}
            sharing-url=${ifDefined(
              this.isLoadingFromClipboard ? undefined : url
            )}
            focus-mode-author=${JSON.stringify(this.focusModeAuthor)}
            focus-mode-recipient=${JSON.stringify(this.focusModeRecipient)}
            focus-mode-content-type=${JSON.stringify(this.focusModeContentType)}
            ?is-showing-metadata=${this.globalIsShowingMetadata}
            ?should-render-markdown=${this.globalShouldRenderMarkdown}
            ?disable-editing-mode-save-button=${true}
            ?disable-preference-button=${true}
            ?disable-image-preview-window=${true}
            ?disable-token-window=${true}
            theme="light"
            style=${this.buildEuphonyStyle(this.euphonyStyleConfig)}
            @refresh-renderer-list-requested=${(
              e: CustomEvent<RefreshRendererListRequest>
            ) => {
              if (this.isFrontendOnlyMode) {
                this.requestWorker
                  .frontendOnlyRefreshRendererListRequestHandler(e)
                  .then(
                    () => {},
                    () => {}
                  );
              } else {
                this.requestWorker.refreshRendererListRequestHandler(e).then(
                  () => {},
                  () => {}
                );
              }
            }}
            @harmony-render-requested=${(
              e: CustomEvent<HarmonyRenderRequest>
            ) => {
              if (this.isFrontendOnlyMode) {
                this.requestWorker
                  .frontendOnlyHarmonyRenderRequestHandler(e)
                  .then(
                    () => {},
                    () => {}
                  );
              } else {
                this.requestWorker.harmonyRenderRequestHandler(e).then(
                  () => {},
                  () => {}
                );
              }
            }}
            @conversation-metadata-button-toggled=${(
              e: CustomEvent<boolean>
            ) => {
              this.conversationMetadataButtonToggled(e).then(
                () => {},
                () => {}
              );
            }}
            @markdown-button-toggled=${(e: CustomEvent<boolean>) => {
              this.markdownButtonToggled(e).then(
                () => {},
                () => {}
              );
            }}
            @translation-requested=${(e: CustomEvent<TranslationRequest>) => {
              if (this.isFrontendOnlyMode) {
                this.ensureOpenAIAPIKey()
                  .then(apiKey => {
                    if (apiKey) {
                      this.requestWorker
                        .frontendOnlyTranslationRequestHandler(e, apiKey)
                        .then(
                          () => {},
                          () => {}
                        );
                    } else {
                      e.detail.reject(
                        'OpenAI API key is required for frontend-only translation.'
                      );
                    }
                  })
                  .catch(() => {});
              } else {
                this.requestWorker.translationRequestHandler(e).then(
                  () => {},
                  () => {}
                );
              }
            }}
            @fetch-message-sharing-url=${(
              e: CustomEvent<MessageSharingRequest>
            ) => {
              this.requestWorker.fetchMessageSharingURLRequestHandler(
                e,
                curID,
                this.urlManager,
                blobPath
              );
            }}
            @harmony-render-button-clicked=${(e: CustomEvent<string>) => {
              this.harmonyRenderButtonClicked(e);
            }}
          ></euphony-codex>
        `;
      } else {
        const curJSON = conversation as Record<string, unknown>;
        euphonyTemplate = html`
          <euphony-json-viewer
            tabindex="0"
            .data=${curJSON}
          ></euphony-json-viewer>
        `;
      }

      // Add a checkbox for editor mode
      let checkboxTemplate = html``;
      if (this.isEditorMode) {
        checkboxTemplate = html`
          <input
            type="checkbox"
            .checked=${this.selectedConversationIDs.has(curID)}
            @change=${(e: InputEvent) => {
              const element = e.target as HTMLInputElement;
              if (element.checked) {
                this.selectedConversationIDs.add(curID);
              } else {
                this.selectedConversationIDs.delete(curID);
              }

              // Update the internal state of the affected conversation
              const conversationElement =
                this.shadowRoot?.querySelector<EuphonyConversation>(
                  `#euphony-conversation-${curID}`
                );
              if (conversationElement) {
                conversationElement.isConvoMarkedForDeletion = !element.checked;
              }

              this.requestUpdate();
            }}
          />
        `;
      }

      conversationsTemplate = html`
        ${conversationsTemplate}
        <div
          class="conversation-container"
          id=${`conversation-${curID}`}
          tabindex="0"
        >
          <span class="conversation-id">
            <span class="share-button"
              ><sl-copy-button
                value=${url}
                size="small"
                copy-label="Copy sharable conversation URL"
              ></sl-copy-button
            ></span>
            ${checkboxTemplate}
            <a href=${`#conversation-${curID}`}>#${curID}</a>
          </span>

          ${euphonyTemplate}
        </div>
      `;
    }

    // Add a download button for editor mode
    let downloadButtonTemplate = html``;
    if (this.isEditorMode) {
      downloadButtonTemplate = html`
        <button
          class="button-load"
          @click=${() => {
            this.downloadButtonClicked();
          }}
        >
          Download
        </button>
      `;
    }

    // Add a select all button for editor mode
    let selectAllButtonTemplate = html``;
    if (this.isEditorMode) {
      selectAllButtonTemplate = html`
        <button
          class="select-all-button"
          @click=${() => {
            this.selectAllButtonClicked();
          }}
        >
          ${this.selectedConversationIDs.size === this.totalConversationSize
            ? 'Unselect All'
            : 'Select All'}
        </button>
      `;
    }

    // Tooltips
    const tooltipTemplate = html`
      <div
        id="popper-tooltip"
        class="popper-tooltip hidden"
        role="tooltip"
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
        }}
      >
        <div class="popper-content">
          <span class="popper-label">Hello</span>
        </div>
        <div class="popper-arrow"></div>
      </div>
    `;

    // Preference window
    const preferenceWindowTemplate = html`
      <euphony-preference-window
        ?is-hidden=${!this.showPreferenceWindow}
        .enabledOptions=${{
          maxMessageHeight: true,
          gridView: true,
          advanced: true,
          messageLabel: true,
          focusMode: true,
          expandAndCollapseAll: true
        }}
        .defaultOptions=${{
          gridView: this.isGridView,
          gridViewColumnWidth: this.gridViewColumnWidth,
          comparisonWidth: this.comparisonColumnWidth
        }}
        @preference-window-close-clicked=${() => {
          this.showPreferenceWindow = false;
        }}
        @max-message-height-changed=${(e: CustomEvent<string>) => {
          this.preferenceWindowMaxMessageHeightChanged(e);
        }}
        @message-label-changed=${(e: CustomEvent<MessageLabelSettings>) => {
          this.preferenceWindowMessageLabelChanged(e);
        }}
        @grid-view-column-width-changed=${(e: CustomEvent<string>) => {
          this.preferenceWindowGridViewColumnWidthChanged(e);
        }}
        @comparison-width-changed=${(e: CustomEvent<string>) => {
          this.preferenceWindowComparisonWidthChanged(e);
        }}
        @layout-changed=${(e: CustomEvent<string>) => {
          this.preferenceWindowLayoutChanged(e);
        }}
        @expand-all-clicked=${() => {
          this.preferenceWindowExpandAllClicked();
        }}
        @collapse-all-clicked=${() => {
          this.preferenceWindowCollapseAllClicked();
        }}
        @translate-all-clicked=${() => {
          this.preferenceWindowTranslateAllClicked();
        }}
        @focus-mode-settings-changed=${(e: CustomEvent<FocusModeSettings>) => {
          this.preferenceWindowFocusModeSettingsChanged(e);
        }}
      ></euphony-preference-window>
    `;

    // Query labels
    let queryLabels = html``;
    if (this.jmespathQuery !== '') {
      queryLabels = html`${queryLabels}
        <div class="query-label">
          <span class="query-label-text">JMESPath=${this.jmespathQuery}</span>
          <span class="query-separator"></span>
          <span
            class="svg-icon icon"
            @click=${() => {
              this.resetFilter('jmespath').then(
                () => {},
                () => {}
              );
            }}
            >${unsafeHTML(iconClose)}</span
          >
        </div> `;
    }

    const contentCenterTemplate = this.isLocalCodexBrowserMode
      ? html`${this.renderLocalCodexBrowser(conversationsTemplate)}`
      : html`
          <div
            class="grid-header"
            ?is-hidden=${this.totalConversationSize === 0}
          >
            ${selectAllButtonTemplate}
            <div class="count-label">
              ${this.isEditorMode
                ? `${NUM_FORMATTER(this.selectedConversationIDs.size)} / `
                : ''}
              ${NUM_FORMATTER(this.totalConversationSize)}
              ${this.jmespathQuery !== '' ? 'matched' : 'total'}
              ${this.dataType === DataType.JSON ? 'items' : 'conversations'}
              ${this.jmespathQuery !== ''
                ? `(${NUM_FORMATTER(this.totalConversationSizeIncludingUnfiltered)} total)`
                : ''}
            </div>
            ${queryLabels}
          </div>

          <div class="conversation-list" ?is-grid-view=${this.isGridView}>
            ${conversationsTemplate}
          </div>

          <div class="footer">
            <nightjar-pagination
              ?is-hidden=${this.totalConversationSize < 1}
              .curPage=${this.curPage}
              .totalPageNum=${this.totalPageNum}
              .itemsPerPage=${this.itemsPerPage}
              .itemsPerPageOptions=${[1, 2, 3, 4, 5, 10, 25, 50, 100]}
              @page-clicked=${(e: CustomEvent<number>) => {
                this.pageClicked(e);
              }}
              @items-per-page-changed=${(e: CustomEvent<number>) => {
                this.itemsPerPageChanged(e);
              }}
            ></nightjar-pagination>
          </div>
        `;

    return html`
      <div
        class="app"
        ?is-loading=${this.isLoadingData}
        style=${this.buildEuphonyStyle(this.appStyleConfig)}
      >
        ${tooltipTemplate} ${preferenceWindowTemplate}

        <nightjar-confirm-dialog
          .header=${'Editor mode'}
          .message=${'Entering editor mode will disable pagination.'}
          .yesButtonText=${'Enter'}
        ></nightjar-confirm-dialog>

        <nightjar-input-dialog
          .header=${'Editor mode'}
          .message=${'Entering editor mode will disable pagination.'}
          .yesButtonText=${'Enter'}
        ></nightjar-input-dialog>

        <euphony-search-window
          @search-query-submitted=${(e: CustomEvent<string>) => {
            this.searchWindowQuerySubmitted(e).then(
              () => {},
              () => {}
            );
          }}
        ></euphony-search-window>

        <euphony-token-window
          @refresh-renderer-list-requested=${(
            e: CustomEvent<RefreshRendererListRequest>
          ) => {
            if (this.isFrontendOnlyMode) {
              this.requestWorker
                .frontendOnlyRefreshRendererListRequestHandler(e)
                .then(
                  () => {},
                  () => {}
                );
            } else {
              this.requestWorker.refreshRendererListRequestHandler(e).then(
                () => {},
                () => {}
              );
            }
          }}
          @harmony-render-requested=${(
            e: CustomEvent<HarmonyRenderRequest>
          ) => {
            if (this.isFrontendOnlyMode) {
              this.requestWorker
                .frontendOnlyHarmonyRenderRequestHandler(e)
                .then(
                  () => {},
                  () => {}
                );
            } else {
              this.requestWorker.harmonyRenderRequestHandler(e).then(
                () => {},
                () => {}
              );
            }
          }}
        ></euphony-token-window>

        <div class="toast-container">
          <nightjar-toast
            id="toast-euphony"
            duration=${TOAST_DURATIONS[this.toastType]}
            message=${this.toastMessage}
            type=${this.toastType}
          ></nightjar-toast>
        </div>

        <div class="header">
          <a class="name" href="./"
            >${this.isEditorMode ? 'Euphony Editor' : 'Euphony'}</a
          >
          <input
            id="local-file-input"
            type="file"
            accept=".json,.jsonl,application/json,application/x-ndjson,text/plain"
            hidden
            @change=${(e: Event) => {
              this.localFileInputChanged(e);
            }}
          />
          <sl-input
            size="small"
            placeholder="Public JSON or JSONL URL"
            value=${initURL}
            clearable
            spellcheck="false"
            @keydown=${(e: KeyboardEvent) => {
              // Avoid triggering the page navigation when pressing arrow keys
              e.stopPropagation();

              const target = e.target as HTMLElement | null;
              // Load the page when pressing enter
              if (e.key === 'Enter') {
                this.loadButtonClicked().then(
                  () => {
                    target?.blur();
                  },
                  () => {}
                );
              }
            }}
          >
          </sl-input>

          <button
            class="button-load"
            @click=${() => {
              this.loadButtonClicked().then(
                () => {},
                () => {}
              );
            }}
          >
            Load
          </button>

          ${downloadButtonTemplate}

          <button
            class="button button-menu"
            @click=${() => {
              this.showToolBarMenu = !this.showToolBarMenu;
              if (this.showToolBarMenu) {
                const menuContainer =
                  this.shadowRoot?.querySelector<HTMLElement>(
                    '.menu-container'
                  );

                if (menuContainer) {
                  menuContainer.focus();
                }
              }
            }}
          >
            <span class="svg-icon question-icon">${unsafeHTML(iconInfo)}</span>
            <div
              class="menu-container"
              ?no-show=${!this.showToolBarMenu}
              tabindex="0"
              @blur=${(e: FocusEvent) => {
                // Ignore the blur event if it is from the button
                const relatedTarget = e.relatedTarget as HTMLElement | null;
                let timeout = 0;
                if (relatedTarget?.classList.contains('button-menu')) {
                  return;
                }

                // Check if the blur event is from the menu's button
                if (relatedTarget?.tagName === 'NIGHTJAR-MENU') {
                  timeout = 200;
                }

                setTimeout(() => {
                  this.showToolBarMenu = false;
                }, timeout);
              }}
            >
              <nightjar-menu
                .menuItems=${[
                  {
                    name: 'Preferences',
                    icon: iconSetting
                  },
                  {
                    name: 'Load without cache',
                    icon: iconCache
                  },
                  {
                    name: 'Load from clipboard',
                    icon: iconClipboard
                  },
                  {
                    name: 'Load local file',
                    icon: iconLaptop
                  },
                  {
                    name: this.isEditorMode
                      ? 'Leave editor mode'
                      : 'Editor mode',
                    icon: iconEdit
                  },
                  {
                    name: 'Filter data',
                    icon: iconFilter
                  },
                  {
                    name: 'Code',
                    icon: iconCode
                  }
                ]}
                @menu-item-clicked=${(e: CustomEvent<MenuItems>) => {
                  this.menuItemClicked(e);
                }}
              ></nightjar-menu>
            </div>
          </button>
        </div>

        <div class="content">
          <div class="loader-container" ?is-loading=${this.isLoadingData}>
            <div class="loader-label">Loading data</div>
            <div class="loader"></div>
          </div>

          <div
            class="empty-error-message"
            ?is-hidden=${this.isLocalCodexBrowserMode ||
            this.totalConversationSize > 0}
          >
            ☹️ No conversation loaded
          </div>

          <div class="content-center">${contentCenterTemplate}</div>

          <div class="content-left">
            <div class="content-left-inner"></div>
            <div class="left-margin-footer">
              <div class="cache-row">
                <div
                  class="cache-info"
                  ?is-hidden=${!this.isLoadingFromCache}
                  @mouseenter=${(e: MouseEvent) => {
                    this.cacheInfoMouseEnter(e);
                  }}
                  @mouseleave=${() => {
                    this.cacheInfoMouseLeave();
                  }}
                >
                  <span class="svg-icon icon">
                    ${unsafeHTML(iconInfoSmall)}
                  </span>
                  <span class="cache-label"> Data loaded from cache</span>
                </div>
              </div>
            </div>
          </div>

          <div class="content-right">
            <div class="content-right-inner"></div>
            <div class="scroll-button-container">
              <button
                class="scroll-button scroll-button-up"
                ?is-visible=${this.showScrollTopButton}
                @click=${() => {
                  this.scrollToTop(0, 'smooth');
                }}
              >
                <span class="svg-icon icon"> ${unsafeHTML(iconArrowUp)} </span>
              </button>
              <button
                class="scroll-button scroll-button-down"
                ?is-visible=${this.showScrollTopButton}
                @click=${() => {
                  this.scrollToBottom('smooth');
                }}
              >
                <span class="svg-icon icon"> ${unsafeHTML(iconArrowUp)} </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  static styles = [
    css`
      ${unsafeCSS(shoelaceCSS)}
      ${unsafeCSS(componentCSS)}
    `
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    'euphony-app': EuphonyApp;
  }
}
