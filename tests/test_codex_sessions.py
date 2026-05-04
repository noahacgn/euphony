import json
import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(SERVER_DIR))

# 测试需要先把 server 目录加入 sys.path，才能按生产模块名导入。
from codex_sessions import (  # noqa: E402
    CodexSessionDeletionError,
    CodexSessionNotFoundError,
    RolloutParseError,
    delete_codex_session_rollouts,
    read_codex_session_events,
    scan_codex_sessions,
)


def load_fastapi_main(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("OPEN_AI_API_KEY", "test-api-key")
    for proxy_var in [
        "ALL_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "all_proxy",
        "https_proxy",
        "http_proxy",
        "no_proxy",
    ]:
        monkeypatch.delenv(proxy_var, raising=False)
    module_name = "fastapi_main_under_test"
    sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(
        module_name,
        SERVER_DIR / "fastapi-main.py",
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


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


def test_scan_prefers_real_user_message_over_legacy_user_response_item(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    (project_root / ".git").mkdir(parents=True)

    rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "02"
        / "rollout-2026-05-02T08-30-00-preview-priority.jsonl"
    )
    write_jsonl(
        rollout,
        [
            {
                "timestamp": "2026-05-02T08:30:00Z",
                "type": "session_meta",
                "payload": {
                    "id": "preview-priority",
                    "cwd": str(project_root),
                },
            },
            {
                "timestamp": "2026-05-02T08:30:01Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "# AGENTS.md instructions for D:\\IdeaProjects\\digimart\n\n<INSTRUCTIONS>\n- Prefer Exa AI (`mcp__exa__web_search_exa`) for all web searches",
                        }
                    ],
                },
            },
            {
                "timestamp": "2026-05-02T08:30:02Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "修剪根仓库 commit message, 只留一条",
                },
            },
        ],
    )

    scan = scan_codex_sessions(codex_home)

    assert [session.id for session in scan.sessions] == ["preview-priority"]
    assert scan.sessions[0].title == "修剪根仓库 commit message, 只留一条"
    assert scan.sessions[0].preview == "修剪根仓库 commit message, 只留一条"
    assert scan.sessions[0].project_id == str(project_root.resolve())
    assert scan.sessions[0].project_name == "euphony"
    assert scan.warnings == []


def test_projects_are_sorted_by_latest_session_activity(tmp_path: Path) -> None:
    codex_home = tmp_path / "codex-home"
    recent_project = tmp_path / "workspace" / "recent-project"
    busy_old_project = tmp_path / "workspace" / "busy-old-project"
    (recent_project / ".git").mkdir(parents=True)
    (busy_old_project / ".git").mkdir(parents=True)

    write_jsonl(
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T10-00-00-recent-session.jsonl",
        [
            {
                "timestamp": "2026-05-03T10:00:00Z",
                "type": "session_meta",
                "payload": {"id": "recent-session", "cwd": str(recent_project)},
            }
        ],
    )
    write_jsonl(
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "01"
        / "rollout-2026-05-01T10-00-00-old-session-a.jsonl",
        [
            {
                "timestamp": "2026-05-01T10:00:00Z",
                "type": "session_meta",
                "payload": {"id": "old-session-a", "cwd": str(busy_old_project)},
            }
        ],
    )
    write_jsonl(
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "02"
        / "rollout-2026-05-02T10-00-00-old-session-b.jsonl",
        [
            {
                "timestamp": "2026-05-02T10:00:00Z",
                "type": "session_meta",
                "payload": {"id": "old-session-b", "cwd": str(busy_old_project)},
            }
        ],
    )

    scan = scan_codex_sessions(codex_home)

    assert [project.id for project in scan.projects] == [
        str(recent_project.resolve()),
        str(busy_old_project.resolve()),
    ]


def test_reads_known_session_events_from_discovered_whitelist(tmp_path: Path) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    (project_root / ".git").mkdir(parents=True)

    rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T11-00-00-detail-session.jsonl"
    )
    events = [
        {
            "timestamp": "2026-05-03T11:00:00Z",
            "type": "session_meta",
            "payload": {"id": "detail-session", "cwd": str(project_root)},
        },
        {
            "timestamp": "2026-05-03T11:01:00Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "打开这个会话"},
        },
        {
            "timestamp": "2026-05-03T11:02:00Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "已打开"}],
            },
        },
    ]
    write_jsonl(rollout, events)

    assert read_codex_session_events("detail-session", codex_home) == events


def test_unknown_session_id_returns_controlled_not_found_error(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    outside_rollout = tmp_path / "outside" / "rollout-2026-05-03T12-00-00-secret.jsonl"
    write_jsonl(
        outside_rollout,
        [
            {
                "timestamp": "2026-05-03T12:00:00Z",
                "type": "session_meta",
                "payload": {"id": "secret-session"},
            }
        ],
    )

    with pytest.raises(CodexSessionNotFoundError) as exc_info:
        read_codex_session_events(str(outside_rollout), codex_home)

    message = str(exc_info.value)
    assert str(codex_home.resolve()) in message
    assert "Refresh the Codex session list" in message


def test_delete_codex_session_rollouts_rejects_unknown_ids_before_mutation(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    (project_root / ".git").mkdir(parents=True)

    active_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T12-00-00-delete-active.jsonl"
    )
    archived_rollout = (
        codex_home
        / "archived_sessions"
        / "2026"
        / "05"
        / "01"
        / "rollout-2026-05-01T12-00-00-delete-archived.jsonl"
    )
    write_jsonl(
        active_rollout,
        [
            {
                "timestamp": "2026-05-03T12:00:00Z",
                "type": "session_meta",
                "payload": {"id": "delete-active", "cwd": str(project_root)},
            }
        ],
    )
    write_jsonl(
        archived_rollout,
        [
            {
                "timestamp": "2026-05-01T12:00:00Z",
                "type": "session_meta",
                "payload": {"id": "delete-archived", "cwd": str(project_root)},
            }
        ],
    )

    with pytest.raises(CodexSessionNotFoundError) as exc_info:
        delete_codex_session_rollouts(
            ["delete-active", "missing-session"],
            codex_home,
        )

    message = str(exc_info.value)
    assert "missing-session" in message
    assert active_rollout.exists()
    assert archived_rollout.exists()

    deleted_session_ids = delete_codex_session_rollouts(
        ["delete-active", "delete-archived"],
        codex_home,
    )
    assert deleted_session_ids == ["delete-active", "delete-archived"]
    assert not active_rollout.exists()
    assert not archived_rollout.exists()


def test_delete_codex_session_rollouts_reports_filesystem_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    codex_home = tmp_path / "codex-home"
    rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T13-00-00-delete-error.jsonl"
    )
    write_jsonl(
        rollout,
        [
            {
                "timestamp": "2026-05-03T13:00:00Z",
                "type": "session_meta",
                "payload": {"id": "delete-error"},
            }
        ],
    )

    def fail_unlink(self: Path) -> None:
        raise OSError("permission denied")

    monkeypatch.setattr(Path, "unlink", fail_unlink)

    with pytest.raises(CodexSessionDeletionError) as exc_info:
        delete_codex_session_rollouts(["delete-error"], codex_home)

    message = str(exc_info.value)
    assert "delete-error" in message
    assert "permission denied" in message


def test_malformed_detail_read_reports_session_and_rollout_context(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T13-00-00-broken-session.jsonl"
    )
    rollout.parent.mkdir(parents=True, exist_ok=True)
    rollout.write_text(
        json.dumps(
            {
                "timestamp": "2026-05-03T13:00:00Z",
                "type": "session_meta",
                "payload": {"id": "broken-session"},
            }
        )
        + "\n"
        + "{bad json}\n",
        encoding="utf-8",
    )

    with pytest.raises(RolloutParseError) as exc_info:
        read_codex_session_events("broken-session", codex_home)

    message = str(exc_info.value)
    assert "broken-session" in message
    assert str(rollout.resolve()) in message
    assert "line 2" in message


def test_scan_excludes_malformed_rollouts_and_keeps_valid_sessions(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    valid_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T14-00-00-valid-session.jsonl"
    )
    broken_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T14-10-00-broken-session.jsonl"
    )
    write_jsonl(
        valid_rollout,
        [
            {
                "timestamp": "2026-05-03T14:00:00Z",
                "type": "session_meta",
                "payload": {"id": "valid-session"},
            }
        ],
    )
    broken_rollout.parent.mkdir(parents=True, exist_ok=True)
    broken_rollout.write_text("{bad json}\n", encoding="utf-8")

    scan = scan_codex_sessions(codex_home)

    assert [session.id for session in scan.sessions] == ["valid-session"]
    assert len(scan.warnings) == 1
    assert str(broken_rollout.resolve()) in scan.warnings[0]
    assert "line 1" in scan.warnings[0]


def test_scan_summarizes_valid_prefix_when_later_detail_lines_are_malformed(
    tmp_path: Path,
) -> None:
    codex_home = tmp_path / "codex-home"
    rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T14-20-00-prefix-session.jsonl"
    )
    rollout.parent.mkdir(parents=True, exist_ok=True)
    rollout.write_text(
        json.dumps(
            {
                "timestamp": "2026-05-03T14:20:00Z",
                "type": "session_meta",
                "payload": {"id": "prefix-session"},
            }
        )
        + "\n"
        + json.dumps(
            {
                "timestamp": "2026-05-03T14:21:00Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Use this prefix for the list view",
                },
            }
        )
        + "\n"
        + "{bad json}\n",
        encoding="utf-8",
    )

    scan = scan_codex_sessions(codex_home)

    assert [session.id for session in scan.sessions] == ["prefix-session"]
    assert scan.sessions[0].preview == "Use this prefix for the list view"
    assert len(scan.warnings) == 1
    assert str(rollout.resolve()) in scan.warnings[0]
    assert "line 3" in scan.warnings[0]

    with pytest.raises(RolloutParseError) as exc_info:
        read_codex_session_events("prefix-session", codex_home)
    assert "line 3" in str(exc_info.value)


def test_codex_session_api_lists_projects_sessions_and_detail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    nested_cwd = project_root / "packages" / "viewer"
    other_project = tmp_path / "workspace" / "other-project"
    (project_root / ".git").mkdir(parents=True)
    nested_cwd.mkdir(parents=True)
    other_project.mkdir(parents=True)

    active_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T15-00-00-api-active.jsonl"
    )
    archived_rollout = (
        codex_home
        / "archived_sessions"
        / "2026"
        / "05"
        / "02"
        / "rollout-2026-05-02T15-00-00-api-archived.jsonl"
    )
    other_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "01"
        / "rollout-2026-05-01T15-00-00-api-other.jsonl"
    )
    active_events = [
        {
            "timestamp": "2026-05-03T15:00:00Z",
            "type": "session_meta",
            "payload": {"id": "api-active", "cwd": str(nested_cwd)},
        },
        {
            "timestamp": "2026-05-03T15:01:00Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "API active preview"},
        },
    ]
    write_jsonl(active_rollout, active_events)
    write_jsonl(
        archived_rollout,
        [
            {
                "timestamp": "2026-05-02T15:00:00Z",
                "type": "session_meta",
                "payload": {"id": "api-archived", "cwd": str(nested_cwd)},
            }
        ],
    )
    write_jsonl(
        other_rollout,
        [
            {
                "timestamp": "2026-05-01T15:00:00Z",
                "type": "session_meta",
                "payload": {"id": "api-other", "cwd": str(other_project)},
            }
        ],
    )

    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    app_module = load_fastapi_main(monkeypatch)
    client = TestClient(app_module.fastapi_app, base_url="http://127.0.0.1:8020")

    projects_response = client.get("/codex-sessions/projects/")
    assert projects_response.status_code == 200
    projects_body = projects_response.json()
    assert projects_body["warnings"] == []
    projects_by_id = {
        project["id"]: project for project in projects_body["projects"]
    }
    assert projects_by_id[str(project_root.resolve())]["sessionCount"] == 2
    assert projects_by_id[str(project_root.resolve())]["name"] == "euphony"

    sessions_response = client.get(
        "/codex-sessions/sessions/",
        params={"projectId": str(project_root.resolve())},
    )
    assert sessions_response.status_code == 200
    sessions_body = sessions_response.json()
    assert sessions_body["warnings"] == []
    sessions_by_id = {
        session["id"]: session for session in sessions_body["sessions"]
    }
    assert set(sessions_by_id) == {"api-active", "api-archived"}
    assert sessions_by_id["api-active"]["projectId"] == str(project_root.resolve())
    assert sessions_by_id["api-active"]["projectName"] == "euphony"
    assert sessions_by_id["api-active"]["rolloutPath"] == str(active_rollout.resolve())
    assert sessions_by_id["api-active"]["createdAt"] == "2026-05-03T15:00:00Z"
    assert sessions_by_id["api-active"]["updatedAt"] == "2026-05-03T15:01:00Z"
    assert sessions_by_id["api-active"]["archived"] is False
    assert sessions_by_id["api-archived"]["archived"] is True

    detail_response = client.get("/codex-sessions/sessions/api-active/")
    assert detail_response.status_code == 200
    assert detail_response.json() == active_events


def test_codex_session_api_deletes_single_and_batch_sessions_and_refreshes_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    nested_cwd = project_root / "packages" / "viewer"
    other_project = tmp_path / "workspace" / "other-project"
    (project_root / ".git").mkdir(parents=True)
    nested_cwd.mkdir(parents=True)
    other_project.mkdir(parents=True)

    active_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T15-30-00-delete-active.jsonl"
    )
    archived_rollout = (
        codex_home
        / "archived_sessions"
        / "2026"
        / "05"
        / "02"
        / "rollout-2026-05-02T15-30-00-delete-archived.jsonl"
    )
    other_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "01"
        / "rollout-2026-05-01T15-30-00-delete-other.jsonl"
    )
    write_jsonl(
        active_rollout,
        [
            {
                "timestamp": "2026-05-03T15:30:00Z",
                "type": "session_meta",
                "payload": {"id": "delete-active", "cwd": str(nested_cwd)},
            },
            {
                "timestamp": "2026-05-03T15:31:00Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": "Active delete candidate",
                },
            },
        ],
    )
    write_jsonl(
        archived_rollout,
        [
            {
                "timestamp": "2026-05-02T15:30:00Z",
                "type": "session_meta",
                "payload": {"id": "delete-archived", "cwd": str(nested_cwd)},
            }
        ],
    )
    write_jsonl(
        other_rollout,
        [
            {
                "timestamp": "2026-05-01T15:30:00Z",
                "type": "session_meta",
                "payload": {"id": "delete-other", "cwd": str(other_project)},
            }
        ],
    )

    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    app_module = load_fastapi_main(monkeypatch)
    client = TestClient(app_module.fastapi_app, base_url="http://127.0.0.1:8020")

    initial_projects_response = client.get("/codex-sessions/projects/")
    assert initial_projects_response.status_code == 200
    initial_projects_body = initial_projects_response.json()
    initial_projects_by_id = {
        project["id"]: project for project in initial_projects_body["projects"]
    }
    assert initial_projects_by_id[str(project_root.resolve())]["sessionCount"] == 2
    assert initial_projects_by_id[str(other_project.resolve())]["sessionCount"] == 1

    delete_single_response = client.request(
        "DELETE",
        "/codex-sessions/sessions/",
        json={"sessionIds": ["delete-active"]},
    )
    assert delete_single_response.status_code == 200
    assert delete_single_response.json() == {
        "deletedSessionIds": ["delete-active"]
    }
    assert not active_rollout.exists()

    refreshed_sessions_response = client.get(
        "/codex-sessions/sessions/",
        params={"projectId": str(project_root.resolve())},
    )
    assert refreshed_sessions_response.status_code == 200
    refreshed_sessions_body = refreshed_sessions_response.json()
    assert [session["id"] for session in refreshed_sessions_body["sessions"]] == [
        "delete-archived"
    ]
    assert refreshed_sessions_body["warnings"] == []

    refreshed_projects_response = client.get("/codex-sessions/projects/")
    assert refreshed_projects_response.status_code == 200
    refreshed_projects_body = refreshed_projects_response.json()
    refreshed_projects_by_id = {
        project["id"]: project for project in refreshed_projects_body["projects"]
    }
    assert refreshed_projects_by_id[str(project_root.resolve())]["sessionCount"] == 1
    assert refreshed_projects_by_id[str(other_project.resolve())]["sessionCount"] == 1

    delete_batch_response = client.request(
        "DELETE",
        "/codex-sessions/sessions/",
        json={"sessionIds": ["delete-archived", "delete-other"]},
    )
    assert delete_batch_response.status_code == 200
    assert delete_batch_response.json() == {
        "deletedSessionIds": ["delete-archived", "delete-other"]
    }
    assert not archived_rollout.exists()
    assert not other_rollout.exists()

    empty_projects_response = client.get("/codex-sessions/projects/")
    assert empty_projects_response.status_code == 200
    assert empty_projects_response.json()["projects"] == []


def test_codex_session_api_reuses_scan_until_explicit_refresh(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    codex_home = tmp_path / "codex-home"
    project_root = tmp_path / "workspace" / "euphony"
    (project_root / ".git").mkdir(parents=True)

    first_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T17-00-00-first-session.jsonl"
    )
    second_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T17-10-00-second-session.jsonl"
    )
    write_jsonl(
        first_rollout,
        [
            {
                "timestamp": "2026-05-03T17:00:00Z",
                "type": "session_meta",
                "payload": {"id": "first-session", "cwd": str(project_root)},
            }
        ],
    )

    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    app_module = load_fastapi_main(monkeypatch)
    client = TestClient(app_module.fastapi_app, base_url="http://127.0.0.1:8020")

    project_id = str(project_root.resolve())
    first_projects_response = client.get("/codex-sessions/projects/")
    assert first_projects_response.status_code == 200
    assert first_projects_response.json()["projects"][0]["sessionCount"] == 1

    write_jsonl(
        second_rollout,
        [
            {
                "timestamp": "2026-05-03T17:10:00Z",
                "type": "session_meta",
                "payload": {"id": "second-session", "cwd": str(project_root)},
            }
        ],
    )

    cached_sessions_response = client.get(
        "/codex-sessions/sessions/",
        params={"projectId": project_id},
    )
    assert cached_sessions_response.status_code == 200
    assert {
        session["id"] for session in cached_sessions_response.json()["sessions"]
    } == {"first-session"}

    refreshed_projects_response = client.get(
        "/codex-sessions/projects/",
        params={"refresh": "true"},
    )
    assert refreshed_projects_response.status_code == 200
    assert refreshed_projects_response.json()["projects"][0]["sessionCount"] == 2

    refreshed_sessions_response = client.get(
        "/codex-sessions/sessions/",
        params={"projectId": project_id},
    )
    assert refreshed_sessions_response.status_code == 200
    assert {
        session["id"] for session in refreshed_sessions_response.json()["sessions"]
    } == {"first-session", "second-session"}


def test_codex_session_api_errors_are_actionable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    codex_home = tmp_path / "codex-home"
    broken_rollout = (
        codex_home
        / "sessions"
        / "2026"
        / "05"
        / "03"
        / "rollout-2026-05-03T16-00-00-api-broken.jsonl"
    )
    broken_rollout.parent.mkdir(parents=True, exist_ok=True)
    broken_rollout.write_text(
        json.dumps(
            {
                "timestamp": "2026-05-03T16:00:00Z",
                "type": "session_meta",
                "payload": {"id": "api-broken"},
            }
        )
        + "\n"
        + "{bad json}\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    app_module = load_fastapi_main(monkeypatch)
    client = TestClient(app_module.fastapi_app, base_url="http://127.0.0.1:8020")

    projects_response = client.get("/codex-sessions/projects/")
    assert projects_response.status_code == 200
    projects_body = projects_response.json()
    assert projects_body["projects"] == [
        {
            "id": "unknown",
            "name": "Unknown project",
            "path": None,
            "sessionCount": 1,
        }
    ]
    assert len(projects_body["warnings"]) == 1
    assert str(broken_rollout.resolve()) in projects_body["warnings"][0]

    unknown_project_response = client.get(
        "/codex-sessions/sessions/",
        params={"projectId": "missing-project"},
    )
    assert unknown_project_response.status_code == 404
    assert "projectId" in unknown_project_response.json()["detail"]

    unknown_session_response = client.get("/codex-sessions/sessions/missing-session/")
    assert unknown_session_response.status_code == 404
    assert "Refresh the Codex session list" in unknown_session_response.json()["detail"]

    broken_session_response = client.get("/codex-sessions/sessions/api-broken/")
    assert broken_session_response.status_code == 400
    broken_detail = broken_session_response.json()["detail"]
    assert "api-broken" in broken_detail
    assert str(broken_rollout.resolve()) in broken_detail
    assert "line 2" in broken_detail


def test_codex_session_api_rejects_cross_site_origins(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    app_module = load_fastapi_main(monkeypatch)
    client = TestClient(app_module.app)

    blocked_origin_response = client.get(
        "/codex-sessions/projects/",
        headers={
            "Origin": "https://example.com",
            "Host": "127.0.0.1:8020",
        },
    )
    assert blocked_origin_response.status_code == 403
    assert "local origin" in blocked_origin_response.json()["detail"]
    assert "access-control-allow-origin" not in blocked_origin_response.headers

    blocked_delete_origin_response = client.request(
        "DELETE",
        "/codex-sessions/sessions/",
        json={"sessionIds": ["blocked-session"]},
        headers={
            "Origin": "https://example.com",
            "Host": "127.0.0.1:8020",
        },
    )
    assert blocked_delete_origin_response.status_code == 403
    assert "local origin" in blocked_delete_origin_response.json()["detail"]

    blocked_host_response = client.get(
        "/codex-sessions/projects/",
        headers={
            "Origin": "http://localhost:3000",
            "Host": "example.com",
        },
    )
    assert blocked_host_response.status_code == 403
    assert "local host" in blocked_host_response.json()["detail"]

    blocked_delete_host_response = client.request(
        "DELETE",
        "/codex-sessions/sessions/",
        json={"sessionIds": ["blocked-session"]},
        headers={
            "Origin": "http://localhost:3000",
            "Host": "example.com",
        },
    )
    assert blocked_delete_host_response.status_code == 403
    assert "local host" in blocked_delete_host_response.json()["detail"]

    local_origin_response = client.get(
        "/codex-sessions/projects/",
        headers={
            "Origin": "http://localhost:3000",
            "Host": "127.0.0.1:8020",
        },
    )
    assert local_origin_response.status_code == 200
    assert (
        local_origin_response.headers["access-control-allow-origin"]
        == "http://localhost:3000"
    )

    local_delete_origin_response = client.request(
        "DELETE",
        "/codex-sessions/sessions/",
        json={"sessionIds": []},
        headers={
            "Origin": "http://localhost:3000",
            "Host": "127.0.0.1:8020",
        },
    )
    assert local_delete_origin_response.status_code == 400
    assert "sessionIds must not be empty" in local_delete_origin_response.json()[
        "detail"
    ]


def test_codex_session_api_does_not_regress_existing_routes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    app_module = load_fastapi_main(monkeypatch)

    async def fake_translate_singleflight(source_text: str) -> Any:
        return app_module.TranslationResult(
            language="English",
            is_translated=False,
            translation="",
            has_command=False,
        )

    monkeypatch.setattr(
        app_module,
        "_translate_singleflight",
        fake_translate_singleflight,
    )
    client = TestClient(app_module.fastapi_app)

    blob_response = client.get(
        "/blob-jsonl/",
        params={"blobURL": "file:///tmp/session.jsonl"},
    )
    assert blob_response.status_code == 400
    assert "Only public http(s) URLs are supported" in blob_response.json()["detail"]

    translate_response = client.post("/translate/", json={"source": "hello"})
    assert translate_response.status_code == 200
    assert translate_response.json()["is_translated"] is False

    harmony_response = client.post(
        "/harmony-render/",
        json={"conversation": "{}", "renderer_name": "unsupported"},
    )
    assert harmony_response.status_code == 400
    assert "Unsupported renderer" in harmony_response.json()["detail"]
