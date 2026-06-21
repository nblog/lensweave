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


def test_api_requires_login(unauthenticated_client) -> None:
    assert unauthenticated_client.get("/api/projects").status_code == 401

    bad_login = unauthenticated_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong"},
    )
    assert bad_login.status_code == 401

    good_login = unauthenticated_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin"},
    )
    assert good_login.status_code == 200
    token = good_login.json()["token"]
    assert token
    assert good_login.json()["username"] == "admin"
    assert good_login.json()["is_admin"] is True

    ok = unauthenticated_client.get(
        "/api/projects",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert ok.status_code == 200


def test_admin_user_management(client) -> None:
    admin_auth = client.headers["Authorization"]

    listed = client.get("/api/admin/users")
    assert listed.status_code == 200
    admin_user = next(user for user in listed.json() if user["username"] == "admin")
    assert admin_user["is_admin"] is True
    assert admin_user["is_active"] is True

    created = client.post(
        "/api/admin/users",
        json={
            "username": "producer",
            "password": "secret123",
            "is_admin": False,
        },
    )
    assert created.status_code == 201
    producer = created.json()
    assert producer["username"] == "producer"
    assert producer["is_admin"] is False
    assert "password_hash" not in producer

    duplicate = client.post(
        "/api/admin/users",
        json={
            "username": "producer",
            "password": "secret123",
            "is_admin": False,
        },
    )
    assert duplicate.status_code == 400

    member_login = client.post(
        "/api/auth/login",
        json={"username": "producer", "password": "secret123"},
    )
    assert member_login.status_code == 200
    member_token = member_login.json()["token"]
    client.headers.update({"Authorization": f"Bearer {member_token}"})
    forbidden = client.get("/api/admin/users")
    assert forbidden.status_code == 403
    client.headers.update({"Authorization": admin_auth})

    disabled = client.patch(
        f"/api/admin/users/{producer['id']}",
        json={"is_active": False},
    )
    assert disabled.status_code == 200
    assert disabled.json()["is_active"] is False
    inactive_login = client.post(
        "/api/auth/login",
        json={"username": "producer", "password": "secret123"},
    )
    assert inactive_login.status_code == 401

    reset = client.patch(
        f"/api/admin/users/{producer['id']}",
        json={"is_active": True, "password": "changed123"},
    )
    assert reset.status_code == 200
    old_password = client.post(
        "/api/auth/login",
        json={"username": "producer", "password": "secret123"},
    )
    assert old_password.status_code == 401
    new_password = client.post(
        "/api/auth/login",
        json={"username": "producer", "password": "changed123"},
    )
    assert new_password.status_code == 200
    assert new_password.json()["is_admin"] is False

    self_disable = client.patch(
        f"/api/admin/users/{admin_user['id']}",
        json={"is_active": False},
    )
    assert self_disable.status_code == 403
    self_delete = client.delete(f"/api/admin/users/{admin_user['id']}")
    assert self_delete.status_code == 403

    deleted = client.delete(f"/api/admin/users/{producer['id']}")
    assert deleted.status_code == 204
    deleted_login = client.post(
        "/api/auth/login",
        json={"username": "producer", "password": "changed123"},
    )
    assert deleted_login.status_code == 401


def test_project_crud(client) -> None:
    created = client.post(
        "/api/projects",
        json={"title": "赘婿翻身", "secondary_password": "246810"},
    )
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


def test_project_delete_removes_owned_rows_but_keeps_global_assets(client) -> None:
    global_asset = client.post(
        "/api/assets",
        json={"kind": "scene", "name": "通用街道", "image_path": "global.png"},
    ).json()
    project = client.post(
        "/api/projects",
        json={"title": "待删除项目", "secondary_password": "246810"},
    ).json()
    project_asset = client.post(
        f"/api/projects/{project['uid']}/assets",
        json={
            "kind": "character",
            "name": "项目角色",
            "source_asset_id": global_asset["id"],
        },
    ).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    temporary_asset = client.post(
        f"/api/episodes/{episode['id']}/assets",
        json={"kind": "prop", "name": "本集道具"},
    ).json()

    from ai_drama.db import (
        Asset,
        Episode,
        GenerationJob,
        Project,
        Segment,
        SessionLocal,
    )

    with SessionLocal() as db:
        segment = Segment(
            episode_id=episode["id"],
            segment_id=1,
            duration_sec=15,
            spec={"visual_prompt": "test"},
        )
        db.add(segment)
        db.commit()
        segment_id = segment.id
        db.add(
            GenerationJob(
                id="project-delete-job",
                kind="video",
                status="queued",
                target_table="segment",
                target_id=segment_id,
                request={},
            )
        )
        db.commit()

    wrong_password = client.request(
        "DELETE",
        f"/api/projects/{project['uid']}",
        json={"secondary_password": "wrong"},
    )
    assert wrong_password.status_code == 403

    deleted = client.request(
        "DELETE",
        f"/api/projects/{project['uid']}",
        json={"secondary_password": "246810"},
    )
    assert deleted.status_code == 204
    assert client.get(f"/api/projects/{project['uid']}").status_code == 404
    assert client.get(f"/api/assets/{global_asset['id']}").status_code == 200

    with SessionLocal() as db:
        assert db.get(Project, project["id"]) is None
        assert db.get(Episode, episode["id"]) is None
        assert db.get(Segment, segment_id) is None
        assert db.get(Asset, project_asset["id"]) is None
        assert db.get(Asset, temporary_asset["id"]) is None
        assert db.get(Asset, global_asset["id"]) is not None
        assert db.get(GenerationJob, "project-delete-job") is None


def test_missing_project_delete_returns_404(client) -> None:
    missing = client.request(
        "DELETE",
        "/api/projects/not-a-real-project-uid",
        json={"secondary_password": "246810"},
    )
    assert missing.status_code == 404
