import json
import sys
from pathlib import Path
from typing import Any

SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(SERVER_DIR))

from codex_sessions import scan_codex_sessions


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )


def test_discovers_active_and_archived_rollouts_grouped_by_project(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    nested_cwd = project_root / "packages" / "viewer"
    fallback_cwd = tmp_path / "scratch" / "one-off"
    (project_root / ".git").mkdir(parents=True)
    nested_cwd.mkdir(parents=True)
    fallback_cwd.mkdir(parents=True)

    active_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T10-20-30-active-session.jsonl"
    )
    archived_rollout = (
        codex_home
        / "archived_sessions"
        / "2026"
        / "04"
        / "30"
        / "rollout-2026-04-30T09-10-11-archived-session.jsonl"
    )
    no_cwd_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "02"
        / "rollout-2026-05-02T08-00-00-no-cwd-session.jsonl"
    )

    write_jsonl(
        active_rollout,
        [
            {
                "timestamp": "2026-05-03T10:20:30Z",
                "type": "session_meta",
                "payload": {
                    "id": "active-session",
                    "cwd": str(nested_cwd),
                },
            },
            {
                "timestamp": "2026-05-03T10:21:00Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "请帮我列出 Codex sessions",
                },
            },
        ],
    )
    write_jsonl(
        archived_rollout,
        [
            {
                "timestamp": "2026-04-30T09:10:11Z",
                "type": "session_meta",
                "payload": {
                    "id": "archived-session",
                    "cwd": str(fallback_cwd),
                },
            },
            {
                "timestamp": "2026-04-30T09:11:00Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Archived preview"}],
                },
            },
        ],
    )
    write_jsonl(
        no_cwd_rollout,
        [
            {
                "timestamp": "2026-05-02T08:00:00Z",
                "type": "session_meta",
                "payload": {"id": "no-cwd-session"},
            }
        ],
    )
    write_jsonl(
        codex_home / "session_index.jsonl",
        [
            {
                "id": "active-session",
                "thread_name": "旧标题",
                "updated_at": "2026-05-03T10:22:00Z",
            },
            {
                "id": "active-session",
                "thread_name": "浏览本地 Codex 会话",
                "updated_at": "2026-05-03T10:23:00Z",
            },
        ],
    )

    scan = scan_codex_sessions(codex_home)

    sessions_by_id = {session.id: session for session in scan.sessions}
    assert set(sessions_by_id) == {
        "active-session",
        "archived-session",
        "no-cwd-session",
    }

    active_session = sessions_by_id["active-session"]
    assert active_session.title == "浏览本地 Codex 会话"
    assert active_session.preview == "请帮我列出 Codex sessions"
    assert active_session.cwd == str(nested_cwd.resolve())
    assert active_session.project_id == str(project_root.resolve())
    assert active_session.project_name == "euphony"
    assert active_session.created_at == "2026-05-03T10:20:30Z"
    assert active_session.updated_at == "2026-05-03T10:21:00Z"
    assert active_session.archived is False

    archived_session = sessions_by_id["archived-session"]
    assert archived_session.title == "Archived preview"
    assert archived_session.project_id == str(fallback_cwd.resolve())
    assert archived_session.project_name == "one-off"
    assert archived_session.archived is True

    no_cwd_session = sessions_by_id["no-cwd-session"]
    assert no_cwd_session.title.startswith("rollout-2026-05-02T08-00-00")
    assert no_cwd_session.cwd is None
    assert no_cwd_session.project_id == "unknown"
    assert no_cwd_session.project_name == "Unknown project"

    projects_by_id = {project.id: project for project in scan.projects}
    assert projects_by_id[str(project_root.resolve())].session_count == 1
    assert projects_by_id[str(fallback_cwd.resolve())].session_count == 1
    assert projects_by_id["unknown"].session_count == 1
