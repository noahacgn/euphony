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

- [x] Task 2: Add whitelist-safe session content reads
  - Acceptance:
    - [x] Known session id returns full rollout event objects in original order.
    - [x] Unknown session id returns a controlled not-found error.
    - [x] Malformed JSONL in detail read returns a clear error with file/session context.
    - [x] List scanning tolerates malformed rollout files by excluding or warning about the bad file without breaking all projects.
    - [x] No public helper accepts frontend-supplied arbitrary file paths for reads.
  - Verify:
    - [x] `pytest tests/test_codex_sessions.py`
  - Files:
    - `server/codex_sessions.py`
    - `tests/test_codex_sessions.py`
    - `tests/fixtures/codex_sessions/...`

## Checkpoint: Backend Foundation

- [x] `pytest tests/test_codex_sessions.py` passes.
- [x] Parser behavior matches `SPEC.md` boundaries.
- [x] No frontend or app behavior changed yet.
- [x] Human review not required; parser contract stayed within the plan.

## Phase 2: Backend API Contract

- [x] Task 3: Expose local Codex session APIs and delete flow
  - Acceptance:
    - [x] `GET /codex-sessions/projects/` returns projects with counts and warnings.
    - [x] `GET /codex-sessions/sessions/?projectId=...` returns only sessions for the requested project.
    - [x] `GET /codex-sessions/sessions/{sessionId}/` returns full event array for a known session.
    - [x] `DELETE /codex-sessions/sessions/` permanently deletes one or more scanned rollout JSONL files by session id.
    - [x] API errors include actionable messages and appropriate HTTP status codes.
    - [x] Existing `/blob-jsonl/`, `/translate/`, `/harmony-render/` routes still behave as before.
  - Verify:
    - [x] `uv run --with pytest python -m pytest tests/test_codex_sessions.py`
    - [x] API checked through FastAPI `TestClient` with temporary `CODEX_HOME`
  - Files:
    - `server/codex_sessions.py`
    - `server/fastapi-main.py`
    - `tests/test_codex_sessions.py`

## Checkpoint: Backend API

- [x] `uv run --with pytest python -m pytest` passes.
- [x] API can be exercised against fixture `CODEX_HOME`.
- [x] Route contracts are stable enough for frontend client work.

## Phase 3: Frontend Client and Local Browser Skeleton

- [x] Task 4: Add frontend API client and types
  - Acceptance:
    - [x] `APIManager` can list local Codex projects.
    - [x] `APIManager` can list sessions for a project id.
    - [x] `APIManager` can read session detail by session id.
    - [x] Types represent backend responses without using arbitrary `any`.
    - [x] Browser-only manager is not extended to read local filesystem APIs.
  - Verify:
    - [x] `node --test tests/frontend/api-manager.codex-sessions.test.mjs`
    - [x] `uv run --with pytest python -m pytest`
    - [x] `pnpm run build`
  - Files:
    - `src/utils/api-manager.ts`
    - `src/types/common-types.ts` or a new focused type file if justified

- [x] Task 5: Render project and session summary browser
  - Acceptance:
    - [x] When no `path` query parameter is present, app loads local Codex projects instead of demo conversations.
    - [x] UI shows project list, selected project, session list, counts, archived marker and manual refresh control.
    - [x] Empty `CODEX_HOME` or backend errors show a clear empty/error state.
    - [x] Existing URL input, menu, file input and clipboard loading remain visible or reachable.
    - [x] No session content is fetched until a session is selected.
  - Verify:
    - [x] `node --test tests/frontend/local-codex-browser.test.mjs`
    - [x] `node --test tests/frontend/api-manager.codex-sessions.test.mjs`
    - [x] `uv run --with pytest python -m pytest`
    - [x] `pnpm run build`
    - [x] Manual browser check with real backend responses at `http://127.0.0.1:8020/`
  - Files:
    - `src/components/app/app.ts`
    - `src/components/app/app.css`
    - `src/components/app/local-codex-browser.ts`
    - `tests/frontend/local-codex-browser.test.mjs`

## Checkpoint: Browsing Skeleton

- [x] Backend tests pass: `pytest`.
- [x] Frontend builds: `pnpm run build`.
- [x] App can display project/session summaries without opening a session.
- [x] Existing remote/local file loaders are still accessible.

## Phase 4: Session Detail End-to-End

- [x] Task 6: Open, render, and delete one local Codex session
  - Acceptance:
    - [x] Clicking a session fetches detail exactly for that session id.
    - [x] Successful detail read renders through existing `<euphony-codex>` content path.
    - [x] Detail read errors show a visible message without clearing the project/session list.
    - [x] Selected session state is visible in the browser.
    - [x] Manual refresh preserves selection when possible and clears it safely when the session disappears.
    - [x] Deleting the selected session from the detail pane clears the detail view and removes the rollout file from the list after refresh.
  - Verify:
    - [x] `node --test tests/frontend/local-codex-browser.test.mjs`
    - [x] `node --test tests/frontend/api-manager.codex-sessions.test.mjs`
    - [x] `uv run --with pytest python -m pytest`
    - [x] `pnpm run build`
    - [x] Manual browser check: select project, select session, see Codex content
  - Files:
    - `src/components/app/app.ts`
    - `src/components/app/app.css`
    - `src/components/app/local-codex-browser.ts`
    - `tests/frontend/local-codex-browser.test.mjs`

- [x] Task 7: Preserve legacy data loading flows
  - Acceptance:
    - [x] Entering a public JSON/JSONL URL still loads data through existing `loadData`.
    - [x] Loading from clipboard still works.
    - [x] Loading local `.json` / `.jsonl` files still works.
    - [x] Existing manually uploaded Codex JSONL still renders as a Codex session.
    - [x] Returning to the app root restores local Codex browser mode.
  - Verify:
    - [x] `node --test tests/frontend/local-data-worker.test.mjs`
    - [x] `node --test --test-concurrency=1 tests/frontend/api-manager.codex-sessions.test.mjs tests/frontend/local-codex-browser.test.mjs tests/frontend/local-data-worker.test.mjs`
    - [x] `uv run --with pytest python -m pytest`
    - [x] `pnpm run build`
    - [x] Manual browser checks for URL load, local file load, manually uploaded Codex JSONL and app root
  - Files:
    - `src/components/app/app.ts`
    - `src/components/app/app.css`
    - `src/components/app/local-data-worker.ts`
    - `tests/frontend/local-data-worker.test.mjs`

## Checkpoint: End-to-End MVP

- [x] `pytest` passes.
- [x] `pnpm run build` passes.
- [x] Real local `CODEX_HOME` can list projects, list sessions and render at least one session.
- [x] Legacy loading flows still work.
- [x] The only write operation against Codex files is the explicit permanent-delete flow, and `session_index.jsonl` is never rewritten.

## Phase 5: Final Verification and Documentation

- [x] Task 8: Run final verification and update docs where needed
  - Acceptance:
    - [x] `pytest` passes.
    - [x] `pnpm run build` passes.
    - [x] Manual backend-assisted local run succeeds against real `CODEX_HOME`.
    - [x] README documents the local backend, `CODEX_HOME`, and `OPEN_AI_API_KEY` requirements.
    - [x] `SPEC.md`, `tasks/plan.md`, and `tasks/todo.md` remain accurate; no spec or plan behavior changes were needed.
  - Verify:
    - [x] `uv run --with pytest python -m pytest`
    - [x] `node --test --test-concurrency=1 tests/frontend/api-manager.codex-sessions.test.mjs tests/frontend/local-codex-browser.test.mjs tests/frontend/local-data-worker.test.mjs`
    - [x] `pnpm run build`
    - [x] Manual browser check at `http://localhost:3000/`
  - Files:
    - `README.md` if run instructions need updating
    - `SPEC.md` if scope decisions changed
    - `tasks/plan.md`
    - `tasks/todo.md`

## Checkpoint: Complete

- [x] All success criteria in `SPEC.md` are met.
- [x] All tasks in this file are complete.
- [x] No warnings remain from tests/build.
- [x] Git diff contains no changes under `lib/`.
- [x] Ready for human review.
