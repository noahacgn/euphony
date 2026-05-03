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


class RolloutParseError(ValueError):
    pass


class CodexSessionNotFoundError(LookupError):
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
            sessions.append(
                _build_session_summary(
                    rollout_path=rollout_path,
                    archived=archived,
                    session_index_titles=session_index_titles,
                )
            )
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


def _discover_rollout_paths(codex_home: Path) -> list[tuple[Path, bool]]:
    rollout_paths: list[tuple[Path, bool]] = []

    active_sessions_dir = codex_home / "sessions"
    if active_sessions_dir.is_dir():
        rollout_paths.extend(
            (path, False) for path in active_sessions_dir.rglob("rollout-*.jsonl")
        )

    archived_sessions_dir = codex_home / "archived_sessions"
    if archived_sessions_dir.is_dir():
        rollout_paths.extend(
            (path, True) for path in archived_sessions_dir.rglob("rollout-*.jsonl")
        )

    return sorted(rollout_paths, key=lambda item: str(item[0]))


def _find_rollout_path_for_session(session_id: str, codex_home: Path) -> Path | None:
    if session_id == "":
        return None

    for rollout_path, _archived in _discover_rollout_paths(codex_home):
        if session_id in _read_session_ids_for_whitelist(rollout_path):
            return rollout_path

    return None


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
) -> CodexSessionSummary:
    events = _read_jsonl_objects(rollout_path)
    filename_id = _session_id_from_filename(rollout_path)
    filename_timestamp = _timestamp_from_filename(rollout_path)
    session_meta = _find_session_meta_payload(events)
    session_id = _get_first_text(session_meta, ["id"]) or filename_id
    if session_id is None:
        raise RolloutParseError(
            f"Failed to parse Codex rollout metadata from {rollout_path}: missing session id."
        )

    cwd = _resolve_cwd(_get_first_text(session_meta, ["cwd"]))
    project_id, project_name = _project_from_cwd(cwd)
    preview = _extract_preview(events)
    created_at = _first_event_timestamp(events) or filename_timestamp
    updated_at = _last_event_timestamp(events) or created_at
    title = session_index_titles.get(session_id) or preview or rollout_path.stem

    return CodexSessionSummary(
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
                        f"Failed to parse JSONL in {path} at line {line_number}: {exc.msg}."
                    ) from exc
                if isinstance(parsed, dict):
                    rows.append(parsed)
    except OSError as exc:
        raise RolloutParseError(f"Failed to read Codex rollout {path}: {exc}.") from exc

    return rows


def _find_session_meta_payload(events: list[dict[str, Any]]) -> dict[str, Any]:
    for event in events:
        if event.get("type") != "session_meta":
            continue
        payload = event.get("payload")
        if isinstance(payload, dict):
            return payload
    return {}


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
    for candidate in [cwd, *cwd.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def _extract_preview(events: list[dict[str, Any]]) -> str:
    for event in events:
        event_type = event.get("type")
        payload = event.get("payload")
        if not isinstance(payload, dict):
            continue

        if event_type == "event_msg" and payload.get("type") == "user_message":
            preview = _text_from_value(payload.get("message"))
            if preview != "":
                return preview

        if (
            event_type == "response_item"
            and payload.get("type") == "message"
            and payload.get("role") == "user"
        ):
            preview = _text_from_value(payload.get("content"))
            if preview != "":
                return preview

    return ""


def _first_event_timestamp(events: list[dict[str, Any]]) -> str | None:
    for event in events:
        timestamp = event.get("timestamp")
        if isinstance(timestamp, str) and timestamp != "":
            return timestamp
    return None


def _last_event_timestamp(events: list[dict[str, Any]]) -> str | None:
    for event in reversed(events):
        timestamp = event.get("timestamp")
        if isinstance(timestamp, str) and timestamp != "":
            return timestamp
    return None


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
        if isinstance(value, str) and value.strip() != "":
            return value.strip()
    return None


def _build_project_summaries(
    sessions: list[CodexSessionSummary],
) -> list[CodexProjectSummary]:
    session_counts: dict[str, int] = {}
    project_names: dict[str, str] = {}
    project_paths: dict[str, str | None] = {}

    for session in sessions:
        session_counts[session.project_id] = session_counts.get(session.project_id, 0) + 1
        project_names[session.project_id] = session.project_name
        project_paths[session.project_id] = (
            None if session.project_id == UNKNOWN_PROJECT_ID else session.project_id
        )

    projects = [
        CodexProjectSummary(
            id=project_id,
            name=project_names[project_id],
            path=project_paths[project_id],
            session_count=session_count,
        )
        for project_id, session_count in session_counts.items()
    ]
    return sorted(projects, key=lambda project: (-project.session_count, project.name))
