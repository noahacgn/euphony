from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_that_addition_still_works() -> None:
    assert 1 + 1 == 2


def test_readme_documents_local_codex_browser_backend_requirement() -> None:
    readme = (PROJECT_ROOT / "README.md").read_text(encoding="utf-8")

    assert "本地 Codex sessions 浏览器" in readme
    assert "CODEX_HOME" in readme
    assert "OPEN_AI_API_KEY" in readme
    assert (
        "uvicorn fastapi-main:app --app-dir server --host 127.0.0.1 --port 8020 --reload"
        in readme
    )
