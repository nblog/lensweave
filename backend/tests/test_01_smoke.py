"""M0 smoke test: the skeleton boots and project CRUD works end to end.

Verifies the core-value path (docs/05 §2 test/01_smoke): the FastAPI app starts
against an isolated SQLite database (see conftest), a project can be created over
HTTP, and it round-trips through list and get.
"""

from __future__ import annotations


def test_default_database_url_points_to_outputs(monkeypatch) -> None:
    """The local SQLite database is part of resettable runtime output state."""

    monkeypatch.delenv("DATABASE_URL", raising=False)

    from ai_drama.config import LOCAL_DATABASE_PATH, get_settings

    get_settings.cache_clear()
    try:
        assert (
            get_settings().database_url
            == f"sqlite:///{LOCAL_DATABASE_PATH.as_posix()}"
        )
    finally:
        get_settings.cache_clear()


def test_sqlite_parent_directory_is_created(tmp_path) -> None:
    """A fresh checkout can create its outputs-backed SQLite database on demand."""

    from ai_drama import db as db_module

    db_path = tmp_path / "outputs" / "ai_drama.db"
    db_module.configure_database(f"sqlite:///{db_path.as_posix()}")
    try:
        db_module.init_db()
        assert db_path.exists()
    finally:
        db_module.engine.dispose()
        db_module.configure_database("sqlite:///:memory:")


def test_health(client) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_project_crud(client) -> None:
    created = client.post("/api/projects", json={"title": "赘婿翻身"})
    assert created.status_code == 201
    project = created.json()
    assert project["title"] == "赘婿翻身"
    assert project["id"] >= 1
    assert project["uid"]

    listed = client.get("/api/projects")
    assert listed.status_code == 200
    assert any(p["uid"] == project["uid"] for p in listed.json())

    fetched = client.get(f"/api/projects/{project['uid']}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "赘婿翻身"

    missing = client.get("/api/projects/not-a-real-project-uid")
    assert missing.status_code == 404
