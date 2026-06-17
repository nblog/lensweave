"""M0 smoke test: the skeleton boots and project CRUD works end to end.

Verifies the core-value path (docs/05 §2 test/01_smoke): the FastAPI app starts
against an isolated SQLite database (see conftest), a project can be created over
HTTP, and it round-trips through list and get.
"""

from __future__ import annotations


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

    listed = client.get("/api/projects")
    assert listed.status_code == 200
    assert any(p["id"] == project["id"] for p in listed.json())

    fetched = client.get(f"/api/projects/{project['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "赘婿翻身"

    missing = client.get("/api/projects/999999")
    assert missing.status_code == 404
