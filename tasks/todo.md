# Todo: Local Codex Sessions Browser

## Phase 1: Backend Discovery Foundation

- [x] Task 1: Build fixture-backed session discovery
  - Acceptance:
    - [x] Active rollout files under `sessions/YYYY/MM/DD/` are discovered.
    - [x] Archived rollout files under `archived_sessions/` are discovered and marked `archived=true`.
    - [x] Session summaries include `id`, `title`, `preview`, `cwd`, `project_id`, `project_name`, `created_at`, `updated_at`, `archived`.
    - [x] Project grouping uses nearest `.git` ancestor for `cwd`; missing Git root falls back to exact `cwd`; missing `cwd` uses `Unknown project`.
    - [x] `session_index.jsonl` latest title wins when present; otherwise title falls back to preview or rollout filename.
  - Verify:
    - [x] `pytest tests/test_codex_sessions.py`
  - Files:
    - `server/codex_sessions.py`
    - `tests/test_codex_sessions.py`
    - `tests/fixtures/codex_sessions/...`

- [ ] Task 2: Add whitelist-safe session content reads
  - Acceptance:
    - Known session id returns full rollout event objects in original order.
    - Unknown session id returns a controlled not-found error.
    - Malformed JSONL in detail read returns a clear error with file/session context.
    - List scanning tolerates malformed rollout files by excluding or warning about the bad file without breaking all projects.
    - No public helper accepts frontend-supplied arbitrary file paths for reads.
  - Verify:
    - `pytest tests/test_codex_sessions.py`
  - Files:
    - `server/codex_sessions.py`
    - `tests/test_codex_sessions.py`
    - `tests/fixtures/codex_sessions/...`

## Checkpoint: Backend Foundation

- [ ] `pytest tests/test_codex_sessions.py` passes.
- [ ] Parser behavior matches `SPEC.md` boundaries.
- [ ] No frontend or app behavior changed yet.
- [ ] Human review if parser contract changed from the plan.

## Phase 2: Backend API Contract

- [ ] Task 3: Expose local Codex session APIs
  - Acceptance:
    - `GET /codex-sessions/projects/` returns projects with counts and warnings.
    - `GET /codex-sessions/sessions/?projectId=...` returns only sessions for the requested project.
    - `GET /codex-sessions/sessions/{sessionId}/` returns full event array for a known session.
    - API errors include actionable messages and appropriate HTTP status codes.
    - Existing `/blob-jsonl/`, `/translate/`, `/harmony-render/` routes still behave as before.
  - Verify:
    - `pytest tests/test_codex_sessions.py`
    - Manual API check with fixture or temporary `CODEX_HOME`
  - Files:
    - `server/codex_sessions.py`
    - `server/fastapi-main.py`
    - `tests/test_codex_sessions.py`

## Checkpoint: Backend API

- [ ] `pytest` passes.
- [ ] API can be exercised against fixture `CODEX_HOME`.
- [ ] Route contracts are stable enough for frontend client work.

## Phase 3: Frontend Client and Local Browser Skeleton

- [ ] Task 4: Add frontend API client and types
  - Acceptance:
    - `APIManager` can list local Codex projects.
    - `APIManager` can list sessions for a project id.
    - `APIManager` can read session detail by session id.
    - Types represent backend responses without using arbitrary `any`.
    - Browser-only manager is not extended to read local filesystem APIs.
  - Verify:
    - `pnpm run build`
  - Files:
    - `src/utils/api-manager.ts`
    - `src/types/common-types.ts` or a new focused type file if justified

- [ ] Task 5: Render project and session summary browser
  - Acceptance:
    - When no `path` query parameter is present, app loads local Codex projects instead of demo conversations.
    - UI shows project list, selected project, session list, counts, archived marker and manual refresh control.
    - Empty `CODEX_HOME` or backend errors show a clear empty/error state.
    - Existing URL input, menu, file input and clipboard loading remain visible or reachable.
    - No session content is fetched until a session is selected.
  - Verify:
    - `pnpm run build`
    - Manual browser check with mocked or real backend responses
  - Files:
    - `src/components/app/app.ts`
    - `src/components/app/app.css`

## Checkpoint: Browsing Skeleton

- [ ] Backend tests pass: `pytest`.
- [ ] Frontend builds: `pnpm run build`.
- [ ] App can display project/session summaries without opening a session.
- [ ] Existing remote/local file loaders are still accessible.

## Phase 4: Session Detail End-to-End

- [ ] Task 6: Open and render one local Codex session
  - Acceptance:
    - Clicking a session fetches detail exactly for that session id.
    - Successful detail read renders through existing `<euphony-codex>` content path.
    - Detail read errors show a visible message without clearing the project/session list.
    - Selected session state is visible in the browser.
    - Manual refresh preserves selection when possible and clears it safely when the session disappears.
  - Verify:
    - `pnpm run build`
    - Manual browser check: select project, select session, see Codex content
  - Files:
    - `src/components/app/app.ts`
    - `src/components/app/app.css`

- [ ] Task 7: Preserve legacy data loading flows
  - Acceptance:
    - Entering a public JSON/JSONL URL still loads data through existing `loadData`.
    - Loading from clipboard still works.
    - Loading local `.json` / `.jsonl` files still works.
    - Existing manually uploaded Codex JSONL still renders as a Codex session.
    - Returning to the app root restores local Codex browser mode.
  - Verify:
    - `pnpm run build`
    - Manual checks for URL load, local file load, clipboard load and app root
  - Files:
    - `src/components/app/app.ts`
    - `src/components/app/app.css`

## Checkpoint: End-to-End MVP

- [ ] `pytest` passes.
- [ ] `pnpm run build` passes.
- [ ] Real local `CODEX_HOME` can list projects, list sessions and render at least one session.
- [ ] Legacy loading flows still work.
- [ ] No write operations against Codex files exist.

## Phase 5: Final Verification and Documentation

- [ ] Task 8: Run final verification and update docs where needed
  - Acceptance:
    - `pytest` passes.
    - `pnpm run build` passes.
    - Manual backend-assisted local run succeeds against real `CODEX_HOME`.
    - README or project docs mention local backend requirement if the user-facing startup flow changed.
    - `SPEC.md`, `tasks/plan.md`, and `tasks/todo.md` remain accurate or are updated before final commit.
  - Verify:
    - `pytest`
    - `pnpm run build`
    - Manual browser check at `http://localhost:3000/`
  - Files:
    - `README.md` if run instructions need updating
    - `SPEC.md` if scope decisions changed
    - `tasks/plan.md`
    - `tasks/todo.md`

## Checkpoint: Complete

- [ ] All success criteria in `SPEC.md` are met.
- [ ] All tasks in this file are complete.
- [ ] No warnings remain from tests/build.
- [ ] Git diff contains no changes under `lib/`.
- [ ] Ready for human review.
