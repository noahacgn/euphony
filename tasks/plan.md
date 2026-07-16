# Implementation Plan: Local Codex Sessions Browser

## Overview

Build a local Codex sessions browser for single-user local Euphony. The browser should default on app launch, scan `CODEX_HOME` through the local FastAPI backend, group sessions by Git-root-derived project, list sessions with metadata, open one session using the existing Codex renderer, and permanently delete scanned rollout JSONL files from the UI when requested. Existing URL, clipboard and local file loading must remain available.

This plan is based on `SPEC.md` and the current code paths:

- Backend app and route registration: `server/fastapi-main.py`
- Frontend API client: `src/utils/api-manager.ts`
- App data loading and render flow: `src/components/app/app.ts`
- Codex renderer: `src/components/codex/codex.ts`
- Codex rollout parser: `src/utils/codex-session.ts`

## Architecture Decisions

- Use JSONL-first metadata extraction. Scan rollout files and `session_index.jsonl`; do not read SQLite in MVP.
- Keep local file access behind backend APIs. The frontend receives project/session ids and never sends arbitrary filesystem paths; the delete flow resolves whitelist paths on the backend.
- Treat session content as lazy-loaded. Lists use summaries; opening a session fetches the full rollout event array.
- Use manual refresh only. No polling, file watchers or persistent cache in MVP.
- Handle malformed JSONL with different strictness by context: list scans are tolerant and report warnings; opening a malformed session fails with a clear error.
- Reuse the existing `<euphony-codex>` renderer for session content instead of adding another render path.

## Dependency Graph

```text
SPEC.md
  │
  ├── Backend fixture data and parser contract
  │     │
  │     ├── Codex home resolution
  │     ├── rollout discovery
  │     ├── session_index title lookup
  │     ├── session metadata extraction
  │     ├── Git-root project grouping
  │     └── whitelist session read
  │
  ├── Backend FastAPI route contract
  │     │
  │     ├── GET /codex-sessions/projects/
  │     ├── GET /codex-sessions/sessions/?projectId=...
  │     └── GET /codex-sessions/sessions/{sessionId}/
  │
  └── Frontend API types/client
        │
        └── App local Codex browser state
              │
              ├── default launch flow
              ├── project list UI
              ├── session list UI
              ├── lazy session detail load
              ├── manual refresh
              └── preserved legacy loaders
```

Implementation order follows this graph: parser and safety first, API routes second, frontend client third, then UI and manual verification.

## Vertical Slices

The work is sliced around user-visible paths:

- Slice 1: backend can safely discover and group sessions from a fixture `CODEX_HOME`.
- Slice 2: frontend can call backend and display project/session summaries.
- Slice 3: user can open one session and render it through existing Codex viewer.
- Slice 4: default local browser flow and legacy loading coexist.
- Slice 5: verification, polish, and documentation alignment.

## Task List

### Phase 1: Backend Discovery Foundation

#### Task 1: Build fixture-backed session discovery

**Description:** Add backend scanner helpers and tests that discover active and archived rollout files from a fixture `CODEX_HOME`, parse minimal metadata, apply `session_index.jsonl` title fallback, and group sessions by project.

**Acceptance criteria:**

- [ ] Active rollout files under `sessions/YYYY/MM/DD/` are discovered.
- [ ] Archived rollout files under `archived_sessions/` are discovered and marked `archived=true`.
- [ ] Session summaries include `id`, `title`, `preview`, `cwd`, `project_id`, `project_name`, `created_at`, `updated_at`, `archived`.
- [ ] Project grouping uses nearest `.git` ancestor for `cwd`; missing Git root falls back to exact `cwd`; missing `cwd` uses `Unknown project`.
- [ ] `session_index.jsonl` latest title wins when present; otherwise title falls back to preview or rollout filename.

**Verification:**

- [ ] `pytest tests/test_codex_sessions.py`

**Dependencies:** None

**Files likely touched:**

- `server/codex_sessions.py`
- `tests/test_codex_sessions.py`
- `tests/fixtures/codex_sessions/...`

**Estimated scope:** Medium, 3-5 files

#### Task 2: Add whitelist-safe session content reads

**Description:** Add backend logic to read full rollout events by session id from the scanner whitelist, with strict malformed JSONL handling for detail reads and no arbitrary path reads.

**Acceptance criteria:**

- [ ] Known session id returns full rollout event objects in original order.
- [ ] Unknown session id returns a controlled not-found error.
- [ ] Malformed JSONL in detail read returns a clear error with file/session context.
- [ ] List scanning tolerates malformed rollout files by excluding or warning about the bad file without breaking all projects.
- [ ] No public helper accepts frontend-supplied arbitrary file paths for reads.

**Verification:**

- [ ] `pytest tests/test_codex_sessions.py`

**Dependencies:** Task 1

**Files likely touched:**

- `server/codex_sessions.py`
- `tests/test_codex_sessions.py`
- `tests/fixtures/codex_sessions/...`

**Estimated scope:** Small to Medium, 2-4 files

### Checkpoint: Backend Foundation

- [ ] `pytest tests/test_codex_sessions.py` passes.
- [ ] Parser behavior matches `SPEC.md` boundaries.
- [ ] No frontend or app behavior changed yet.
- [ ] Human review if parser contract changed from this plan.

### Phase 2: Backend API Contract

#### Task 3: Expose local Codex session APIs and delete flow

**Description:** Register FastAPI routes for projects, sessions by project, session content, and permanent deletion. Use Pydantic response models and keep the route surface separate from existing remote `/blob-jsonl/` behavior.

**Acceptance criteria:**

- [ ] `GET /codex-sessions/projects/` returns projects with counts and warnings.
- [ ] `GET /codex-sessions/sessions/?projectId=...` returns only sessions for the requested project.
- [ ] `GET /codex-sessions/sessions/{sessionId}/` returns full event array for a known session.
- [ ] `DELETE /codex-sessions/sessions/` permanently deletes one or more scanned rollout JSONL files by session id.
- [ ] API errors include actionable messages and appropriate HTTP status codes.
- [ ] Existing `/blob-jsonl/`, `/translate/`, `/harmony-render/` routes still behave as before.

**Verification:**

- [ ] `pytest tests/test_codex_sessions.py`
- [ ] Manual API check with fixture or temporary `CODEX_HOME`

**Dependencies:** Tasks 1-2

**Files likely touched:**

- `server/codex_sessions.py`
- `server/fastapi-main.py`
- `tests/test_codex_sessions.py`

**Estimated scope:** Medium, 3 files

### Checkpoint: Backend API

- [ ] `pytest` passes.
- [ ] API can be exercised against fixture `CODEX_HOME`.
- [ ] Route contracts are stable enough for frontend client work.

### Phase 3: Frontend Client and Local Browser Skeleton

#### Task 4: Add frontend API client and types

**Description:** Add typed methods to the frontend API manager for local Codex projects, project sessions, and session detail. Keep frontend-only remote loading behavior unchanged.

**Acceptance criteria:**

- [ ] `APIManager` can list local Codex projects.
- [ ] `APIManager` can list sessions for a project id.
- [ ] `APIManager` can read session detail by session id.
- [ ] Types represent backend responses without using arbitrary `any`.
- [ ] Browser-only manager is not extended to read local filesystem APIs.

**Verification:**

- [ ] `pnpm run build`

**Dependencies:** Task 3

**Files likely touched:**

- `src/utils/api-manager.ts`
- `src/types/common-types.ts` or a new focused type file if justified

**Estimated scope:** Small, 1-2 files

#### Task 5: Render project and session summary browser

**Description:** Add local Codex browser state and render path in `EuphonyApp` that displays projects and sessions from backend summaries without opening session content yet.

**Acceptance criteria:**

- [ ] When no `path` query parameter is present, app loads local Codex projects instead of demo conversations.
- [ ] UI shows project list, selected project, session list, counts, archived marker and manual refresh control.
- [ ] Empty `CODEX_HOME` or backend errors show a clear empty/error state.
- [ ] Existing URL input, menu, file input and clipboard loading remain visible or reachable.
- [ ] No session content is fetched until a session is selected.

**Verification:**

- [ ] `pnpm run build`
- [ ] Manual browser check with mocked or real backend responses

**Dependencies:** Task 4

**Files likely touched:**

- `src/components/app/app.ts`
- `src/components/app/app.css`

**Estimated scope:** Medium, 2 files

### Checkpoint: Browsing Skeleton

- [ ] Backend tests pass: `pytest`.
- [ ] Frontend builds: `pnpm run build`.
- [ ] App can display project/session summaries without opening a session.
- [ ] Existing remote/local file loaders are still accessible.

### Phase 4: Session Detail End-to-End

#### Task 6: Open, render, and delete one local Codex session

**Description:** Connect session selection to lazy detail fetch and feed the returned event array into existing `DataType.CODEX` / `<euphony-codex>` rendering.

**Acceptance criteria:**

- [ ] Clicking a session fetches detail exactly for that session id.
- [ ] Successful detail read renders through existing `<euphony-codex>` content path.
- [ ] Detail read errors show a visible message without clearing the project/session list.
- [ ] Selected session state is visible in the browser.
- [ ] Manual refresh preserves selection when possible and clears it safely when the session disappears.
- [ ] Deleting the selected session from the detail pane clears the detail view and removes the rollout file from the list after refresh.

**Verification:**

- [ ] `pnpm run build`
- [ ] Manual browser check: select project, select session, see Codex content

**Dependencies:** Task 5

**Files likely touched:**

- `src/components/app/app.ts`
- `src/components/app/app.css`

**Estimated scope:** Medium, 2 files

#### Task 7: Preserve legacy data loading flows

**Description:** Ensure the new default local browser does not regress existing URL, clipboard, file, pagination, and Codex JSONL upload behaviors.

**Acceptance criteria:**

- [ ] Entering a public JSON/JSONL URL still loads data through existing `loadData`.
- [ ] Loading from clipboard still works.
- [ ] Loading local `.json` / `.jsonl` files still works.
- [ ] Existing manually uploaded Codex JSONL still renders as a Codex session.
- [ ] Returning to the app root restores local Codex browser mode.

**Verification:**

- [ ] `pnpm run build`
- [ ] Manual checks for URL load, local file load, clipboard load and app root

**Dependencies:** Task 6

**Files likely touched:**

- `src/components/app/app.ts`
- `src/components/app/app.css`

**Estimated scope:** Small to Medium, 2 files

### Checkpoint: End-to-End MVP

- [ ] `pytest` passes.
- [ ] `pnpm run build` passes.
- [ ] Real local `CODEX_HOME` can list projects, list sessions and render at least one session.
- [ ] Legacy loading flows still work.
- [ ] The only write operation against Codex files is the explicit permanent-delete flow, and `session_index.jsonl` is never rewritten.

### Phase 5: Final Verification and Documentation

#### Task 8: Run final verification and update docs where needed

**Description:** Complete final quality gate, document run instructions or known limitations if implementation behavior differs from existing README, and ensure planned boundaries still match shipped behavior.

**Acceptance criteria:**

- [ ] `pytest` passes.
- [ ] `pnpm run build` passes.
- [ ] Manual backend-assisted local run succeeds against real `CODEX_HOME`.
- [ ] README or project docs mention local backend requirement if the user-facing startup flow changed.
- [ ] `SPEC.md`, `tasks/plan.md`, and `tasks/todo.md` remain accurate or are updated before final commit.

**Verification:**

- [ ] `pytest`
- [ ] `pnpm run build`
- [ ] Manual browser check at `http://localhost:43127/`

**Dependencies:** Tasks 1-7

**Files likely touched:**

- `README.md` if run instructions need updating
- `SPEC.md` if scope decisions changed
- `tasks/plan.md`
- `tasks/todo.md`

**Estimated scope:** Small, 1-4 files

### Checkpoint: Complete

- [ ] All success criteria in `SPEC.md` are met.
- [ ] All tasks in `tasks/todo.md` are complete.
- [ ] No warnings remain from tests/build.
- [ ] Git diff contains no changes under `lib/`.
- [ ] Ready for human review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Large `CODEX_HOME` scan is slow | Medium | Start with manual refresh and no polling; measure before adding cache. |
| Historical rollout schema varies | Medium | Keep parser tolerant for list summaries and reuse existing Codex renderer for content. |
| Malformed rollout blocks browsing | Medium | List scans tolerate bad files and report warnings; detail reads fail clearly for the selected bad session. |
| Local file read API becomes too broad | High | Only read files discovered under resolved `CODEX_HOME`; frontend passes ids, not paths. |
| Default local browser breaks existing demo/load flows | Medium | Keep legacy loaders reachable and add a dedicated regression task. |
| UI changes in `app.ts` become too large | Medium | Use a small number of focused state fields and render helpers; avoid new component extraction unless the file becomes unmanageable. |

## Parallelization Opportunities

- Tasks 1 and 2 are mostly sequential because whitelist-safe reads depend on discovery.
- After Task 3 stabilizes API contracts, Task 4 can proceed independently from UI layout details.
- Task 7 legacy regression checks can be performed in parallel with Task 8 documentation once Task 6 is done.
- Do not parallelize edits to `src/components/app/app.ts` across multiple workers without explicit file ownership; it is the central integration point.

## Open Questions

- Should session ordering be strictly `updatedAt desc`, or should active sessions sort ahead of archived sessions?
- Should warnings from tolerant list scans be shown in the UI immediately, or kept in API metadata for later inspection?
- Should root `/` always attempt local browser first, or only when backend-assisted mode is active and local Codex API responds successfully?
