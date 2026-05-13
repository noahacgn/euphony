import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

UNKNOWN_PROJECT_ID = "unknown"
UNKNOWN_PROJECT_NAME = "Unknown project"
ROLLOUT_FILENAME_RE = re.compile(
    r"^rollout-(?P<timestamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(?P<id>.+)\.jsonl$"
)


@dataclass(frozen=True)
class CodexSessionSummary:
    id: str
    title: str
    preview: str
    cwd: str | None
    project_id: str
    project_name: str
    rollout_path: str
    created_at: str | None
    updated_at: str | None
    archived: bool
    thread_source: str | None
    parent_session_id: str | None
    agent_nickname: str | None


@dataclass(frozen=True)
class CodexProjectSummary:
    id: str
    name: str
    path: str | None
    session_count: int


@dataclass(frozen=True)
class CodexSessionScanResult:
    projects: list[CodexProjectSummary]
    sessions: list[CodexSessionSummary]
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _RolloutSummaryFields:
    session_meta: dict[str, Any]
    preview: str
    first_timestamp: str | None
    last_timestamp: str | None
    warning: str | None = None


class RolloutParseError(ValueError):
    pass


class CodexSessionNotFoundError(LookupError):
    pass


class CodexSessionDeletionError(RuntimeError):
    pass


def resolve_codex_home(codex_home: Path | str | None = None) -> Path:
    raw_codex_home = codex_home
    if raw_codex_home is None:
        raw_codex_home = os.environ.get("CODEX_HOME", Path.home() / ".codex")

    return Path(raw_codex_home).expanduser().resolve()


def scan_codex_sessions(codex_home: Path | str | None = None) -> CodexSessionScanResult:
    resolved_codex_home = resolve_codex_home(codex_home)
    session_index_titles = _read_session_index_titles(resolved_codex_home)

    sessions: list[CodexSessionSummary] = []
    warnings: list[str] = []
    for rollout_path, archived in _discover_rollout_paths(resolved_codex_home):
        try:
            session_summary, warning = _build_session_summary(
                rollout_path=rollout_path,
                archived=archived,
                session_index_titles=session_index_titles,
            )
            sessions.append(session_summary)
            if warning is not None:
                warnings.append(warning)
        except RolloutParseError as exc:
            warnings.append(str(exc))

    sessions.sort(
        key=lambda session: (
            session.updated_at is not None,
            session.updated_at or "",
            session.id,
        ),
        reverse=True,
    )
    projects = _build_project_summaries(sessions)
    return CodexSessionScanResult(projects=projects, sessions=sessions, warnings=warnings)


def read_codex_session_events(
    session_id: str,
    codex_home: Path | str | None = None,
) -> list[dict[str, Any]]:
    resolved_codex_home = resolve_codex_home(codex_home)
    requested_session_id = session_id.strip()
    rollout_path = _find_rollout_path_for_session(
        session_id=requested_session_id,
        codex_home=resolved_codex_home,
    )
    if rollout_path is None:
        raise CodexSessionNotFoundError(
            "Failed to read Codex session "
            f"{requested_session_id!r} from {resolved_codex_home}: session id is not "
            "known from the discovered rollout whitelist. Refresh the Codex session "
            "list and select a session returned by the local backend."
        )

    try:
        return _read_jsonl_objects(rollout_path)
    except RolloutParseError as exc:
        raise RolloutParseError(
            "Failed to read Codex session "
            f"{requested_session_id!r} from {rollout_path.resolve()}: {exc}"
        ) from exc


def delete_codex_session_rollouts(
    session_ids: list[str],
    codex_home: Path | str | None = None,
    *,
    scan: CodexSessionScanResult | None = None,
) -> list[str]:
    resolved_codex_home = resolve_codex_home(codex_home)
    requested_session_ids = _normalize_requested_session_ids(session_ids)
    codex_scan = scan if scan is not None else scan_codex_sessions(resolved_codex_home)
    session_by_id = {session.id: session for session in codex_scan.sessions}

    missing_session_ids = [
        session_id
        for session_id in requested_session_ids
        if session_id not in session_by_id
    ]
    if missing_session_ids:
        formatted_missing_session_ids = ", ".join(
            repr(session_id) for session_id in missing_session_ids
        )
        raise CodexSessionNotFoundError(
            "Failed to delete Codex sessions "
            f"from {resolved_codex_home}: session id(s) {formatted_missing_session_ids} "
            "are not known from the discovered rollout whitelist. Refresh the Codex "
            "session list and select sessions returned by the local backend."
        )

    deleted_session_ids: list[str] = []
    for session_id in requested_session_ids:
        rollout_path = Path(session_by_id[session_id].rollout_path)
        try:
            rollout_path.unlink()
        except FileNotFoundError as exc:
            raise CodexSessionDeletionError(
                "Failed to delete Codex session "
                f"{session_id!r} at {rollout_path.resolve(strict=False)}: the rollout "
                "file no longer exists."
            ) from exc
        except OSError as exc:
            raise CodexSessionDeletionError(
                "Failed to delete Codex session "
                f"{session_id!r} at {rollout_path.resolve(strict=False)}: {exc}."
            ) from exc
        deleted_session_ids.append(session_id)

    return deleted_session_ids


def _discover_rollout_paths(codex_home: Path) -> list[tuple[Path, bool]]:
    rollout_paths: list[tuple[Path, bool]] = []

    for rollout_dir, archived in (
        (codex_home / "sessions", False),
        (codex_home / "archived_sessions", True),
    ):
        if rollout_dir.is_dir():
            rollout_paths.extend(
                (path, archived) for path in rollout_dir.rglob("rollout-*.jsonl")
            )

    return sorted(rollout_paths, key=lambda item: str(item[0]))


def _find_rollout_path_for_session(session_id: str, codex_home: Path) -> Path | None:
    if session_id == "":
        return None

    for rollout_path, _ in _discover_rollout_paths(codex_home):
        if session_id in _read_session_ids_for_whitelist(rollout_path):
            return rollout_path

    return None


def _normalize_requested_session_ids(session_ids: list[str]) -> list[str]:
    normalized_session_ids: list[str] = []
    seen_session_ids: set[str] = set()

    for raw_session_id in session_ids:
        session_id = raw_session_id.strip()
        if session_id == "":
            raise ValueError(
                "Failed to delete Codex sessions: sessionIds must not contain empty "
                "values."
            )
        if session_id in seen_session_ids:
            continue
        seen_session_ids.add(session_id)
        normalized_session_ids.append(session_id)

    if not normalized_session_ids:
        raise ValueError(
            "Failed to delete Codex sessions: sessionIds must not be empty."
        )

    return normalized_session_ids


def _read_session_ids_for_whitelist(path: Path) -> set[str]:
    session_ids: set[str] = set()
    filename_id = _session_id_from_filename(path)
    if filename_id is not None:
        session_ids.add(filename_id)

    session_meta_id = _read_session_meta_id(path)
    if session_meta_id is not None:
        session_ids.add(session_meta_id)

    return session_ids


def _read_session_meta_id(path: Path) -> str | None:
    try:
        with path.open(encoding="utf-8") as file:
            for line in file:
                stripped_line = line.strip()
                if stripped_line == "":
                    continue
                try:
                    parsed = json.loads(stripped_line)
                except json.JSONDecodeError:
                    return None
                if not isinstance(parsed, dict):
                    continue
                if parsed.get("type") != "session_meta":
                    continue
                payload = parsed.get("payload")
                if isinstance(payload, dict):
                    return _get_first_text(payload, ["id"])
    except OSError:
        return None

    return None


def _read_session_index_titles(codex_home: Path) -> dict[str, str]:
    session_index_path = codex_home / "session_index.jsonl"
    if not session_index_path.is_file():
        return {}

    titles: dict[str, str] = {}
    try:
        rows = _read_jsonl_objects(session_index_path)
    except RolloutParseError:
        return titles

    for row in rows:
        session_id = _get_first_text(row, ["id", "thread_id", "session_id"])
        thread_name = _get_first_text(row, ["thread_name", "title"])
        if session_id is not None and thread_name is not None:
            titles[session_id] = thread_name

    return titles


def _build_session_summary(
    *,
    rollout_path: Path,
    archived: bool,
    session_index_titles: dict[str, str],
) -> tuple[CodexSessionSummary, str | None]:
    summary_fields = _scan_rollout_summary(rollout_path)
    filename_id = _session_id_from_filename(rollout_path)
    filename_timestamp = _timestamp_from_filename(rollout_path)
    session_meta = summary_fields.session_meta
    session_id = _get_first_text(session_meta, ["id"]) or filename_id
    if session_id is None:
        raise RolloutParseError(
            f"Failed to parse Codex rollout metadata from {rollout_path}: missing session id."
        )

    cwd = _resolve_cwd(_get_first_text(session_meta, ["cwd"]))
    project_id, project_name = _project_from_cwd(cwd)
    preview = summary_fields.preview
    created_at = summary_fields.first_timestamp or filename_timestamp
    updated_at = summary_fields.last_timestamp or created_at
    title = session_index_titles.get(session_id) or preview or rollout_path.stem
    thread_source = _get_first_text(session_meta, ["thread_source"])
    parent_session_id = _extract_parent_session_id(session_meta, thread_source)
    agent_nickname = _extract_agent_nickname(session_meta)

    return (
        CodexSessionSummary(
            id=session_id,
            title=title,
            preview=preview,
            cwd=cwd,
            project_id=project_id,
            project_name=project_name,
            rollout_path=str(rollout_path.resolve()),
            created_at=created_at,
            updated_at=updated_at,
            archived=archived,
            thread_source=thread_source,
            parent_session_id=parent_session_id,
            agent_nickname=agent_nickname,
        ),
        summary_fields.warning,
    )


def _scan_rollout_summary(path: Path) -> _RolloutSummaryFields:
    session_meta: dict[str, Any] = {}
    preferred_preview = ""
    legacy_preview = ""
    first_timestamp: str | None = None
    last_timestamp: str | None = None

    try:
        with path.open(encoding="utf-8") as file:
            for line_number, line in enumerate(file, start=1):
                stripped_line = line.strip()
                if stripped_line == "":
                    continue
                try:
                    parsed = json.loads(stripped_line)
                except json.JSONDecodeError as exc:
                    warning = _jsonl_parse_error(path, line_number, exc)
                    preview = preferred_preview or legacy_preview
                    if first_timestamp is None and not session_meta and preview == "":
                        raise RolloutParseError(warning) from exc
                    return _RolloutSummaryFields(
                        session_meta=session_meta,
                        preview=preview,
                        first_timestamp=first_timestamp,
                        last_timestamp=last_timestamp,
                        warning=warning,
                    )
                if not isinstance(parsed, dict):
                    continue

                timestamp = parsed.get("timestamp")
                if isinstance(timestamp, str) and timestamp != "":
                    if first_timestamp is None:
                        first_timestamp = timestamp
                    last_timestamp = timestamp

                if parsed.get("type") == "session_meta":
                    payload = parsed.get("payload")
                    if not session_meta and isinstance(payload, dict):
                        session_meta = payload

                if preferred_preview == "":
                    preferred_preview = _extract_user_message_preview(parsed)
                if legacy_preview == "":
                    legacy_preview = _extract_legacy_user_preview(parsed)
    except OSError as exc:
        raise RolloutParseError(f"Failed to read Codex rollout {path}: {exc}.") from exc

    return _RolloutSummaryFields(
        session_meta=session_meta,
        preview=preferred_preview or legacy_preview,
        first_timestamp=first_timestamp,
        last_timestamp=last_timestamp,
    )


def _read_jsonl_objects(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as file:
            for line_number, line in enumerate(file, start=1):
                stripped_line = line.strip()
                if stripped_line == "":
                    continue
                try:
                    parsed = json.loads(stripped_line)
                except json.JSONDecodeError as exc:
                    raise RolloutParseError(
                        _jsonl_parse_error(path, line_number, exc)
                    ) from exc
                if isinstance(parsed, dict):
                    rows.append(parsed)
    except OSError as exc:
        raise RolloutParseError(f"Failed to read Codex rollout {path}: {exc}.") from exc

    return rows


def _jsonl_parse_error(
    path: Path,
    line_number: int,
    exc: json.JSONDecodeError,
) -> str:
    return f"Failed to parse JSONL in {path} at line {line_number}: {exc.msg}."


def _session_id_from_filename(path: Path) -> str | None:
    match = ROLLOUT_FILENAME_RE.match(path.name)
    if match is None:
        return None
    return match.group("id")


def _timestamp_from_filename(path: Path) -> str | None:
    match = ROLLOUT_FILENAME_RE.match(path.name)
    if match is None:
        return None
    date_part, time_part = match.group("timestamp").split("T", maxsplit=1)
    return f"{date_part}T{time_part.replace('-', ':')}Z"


def _resolve_cwd(cwd: str | None) -> str | None:
    if cwd is None:
        return None
    return str(Path(cwd).expanduser().resolve())


def _project_from_cwd(cwd: str | None) -> tuple[str, str]:
    if cwd is None:
        return UNKNOWN_PROJECT_ID, UNKNOWN_PROJECT_NAME

    cwd_path = Path(cwd)
    git_root = _find_git_root(cwd_path)
    project_path = git_root if git_root is not None else cwd_path
    return str(project_path), project_path.name or str(project_path)


def _find_git_root(cwd: Path) -> Path | None:
    for candidate in (cwd, *cwd.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _extract_user_message_preview(event: dict[str, Any]) -> str:
    event_type = event.get("type")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return ""

    if event_type == "event_msg" and payload.get("type") == "user_message":
        return _text_from_value(payload.get("message"))

    return ""


def _extract_legacy_user_preview(event: dict[str, Any]) -> str:
    event_type = event.get("type")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return ""

    if (
        event_type == "response_item"
        and payload.get("type") == "message"
        and payload.get("role") == "user"
    ):
        return _text_from_value(payload.get("content"))

    return ""


def _text_from_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(
            text for item in value if (text := _text_from_value(item)) != ""
        )
    if isinstance(value, dict):
        for key in ["text", "content", "message", "value"]:
            if key in value:
                return _text_from_value(value[key])
    return ""


def _get_first_text(source: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = source.get(key)
        if not isinstance(value, str):
            continue
        stripped_value = value.strip()
        if stripped_value != "":
            return stripped_value
    return None


def _extract_parent_session_id(
    session_meta: dict[str, Any],
    thread_source: str | None,
) -> str | None:
    parent_thread_id = _get_nested_text(
        session_meta,
        ["source", "subagent", "thread_spawn", "parent_thread_id"],
    )
    if parent_thread_id is not None:
        return parent_thread_id

    if thread_source == "subagent":
        return _get_first_text(session_meta, ["forked_from_id"])

    return None


def _extract_agent_nickname(session_meta: dict[str, Any]) -> str | None:
    return _get_first_text(session_meta, ["agent_nickname"]) or _get_nested_text(
        session_meta,
        ["source", "subagent", "thread_spawn", "agent_nickname"],
    )


def _get_nested_text(source: dict[str, Any], path: list[str]) -> str | None:
    current_value: Any = source
    for key in path:
        if not isinstance(current_value, dict):
            return None
        current_value = current_value.get(key)

    if not isinstance(current_value, str):
        return None

    stripped_value = current_value.strip()
    if stripped_value == "":
        return None
    return stripped_value


def _build_project_summaries(
    sessions: list[CodexSessionSummary],
) -> list[CodexProjectSummary]:
    session_counts: dict[str, int] = {}
    project_names: dict[str, str] = {}
    project_paths: dict[str, str | None] = {}
    project_latest_updates: dict[str, str | None] = {}

    for session in sessions:
        session_counts[session.project_id] = session_counts.get(session.project_id, 0) + 1
        project_names[session.project_id] = session.project_name
        project_paths[session.project_id] = (
            None if session.project_id == UNKNOWN_PROJECT_ID else session.project_id
        )
        previous_latest = project_latest_updates.get(session.project_id)
        if previous_latest is None or (
            session.updated_at is not None and session.updated_at > previous_latest
        ):
            project_latest_updates[session.project_id] = session.updated_at

    projects = [
        CodexProjectSummary(
            id=project_id,
            name=project_names[project_id],
            path=project_paths[project_id],
            session_count=session_count,
        )
        for project_id, session_count in session_counts.items()
    ]
    projects.sort(key=lambda project: project.name)
    projects.sort(key=lambda project: project.session_count, reverse=True)
    projects.sort(
        key=lambda project: (
            project_latest_updates[project.id] is not None,
            project_latest_updates[project.id] or "",
        ),
        reverse=True,
    )
    return projects
