"""Layered asset CRUD over HTTP.

Assets can be global, fixed to one project, or temporary inside one episode.
"""

from __future__ import annotations


def test_create_project_asset_with_description(client) -> None:
    project_uid = client.post("/api/projects", json={"title": "P"}).json()["uid"]
    asset = client.post(
        f"/api/projects/{project_uid}/assets",
        json={
            "kind": "character",
            "name": "女主·林夏",
            "description": "短发，红色卫衣",
            "image_path": "data:image/png;base64,AAAA",
        },
    ).json()

    assert asset["description"] == "短发，红色卫衣"
    assert asset["name"] == "女主·林夏"
    assert asset["project_id"] > 0
    assert asset["episode_id"] is None
    assert asset["scope"] == "fixed"

    fetched = client.get(f"/api/projects/{project_uid}/assets/{asset['id']}").json()
    assert fetched["description"] == "短发，红色卫衣"


def test_description_defaults_to_null(client) -> None:
    project_uid = client.post("/api/projects", json={"title": "P"}).json()["uid"]
    asset = client.post(
        f"/api/projects/{project_uid}/assets", json={"kind": "prop", "name": "雨伞"}
    ).json()
    assert asset["description"] is None


def test_project_asset_delete_is_scoped(client) -> None:
    project_uid = client.post("/api/projects", json={"title": "P"}).json()["uid"]
    asset = client.post(
        f"/api/projects/{project_uid}/assets",
        json={"kind": "scene", "name": "前院"},
    ).json()
    aid = asset["id"]

    assert client.delete(f"/api/projects/{project_uid}/assets/{aid}").status_code == 204
    assert client.get(f"/api/projects/{project_uid}/assets/{aid}").status_code == 404
    assert client.get(f"/api/projects/{project_uid}/assets").json() == []


def test_project_asset_can_be_updated_and_image_cleared(client) -> None:
    project_uid = client.post("/api/projects", json={"title": "P"}).json()["uid"]
    asset = client.post(
        f"/api/projects/{project_uid}/assets",
        json={
            "kind": "character",
            "name": "旧角色",
            "description": "旧描述",
            "image_path": "old.png",
        },
    ).json()

    updated = client.patch(
        f"/api/projects/{project_uid}/assets/{asset['id']}",
        json={
            "kind": "prop",
            "name": "新道具",
            "description": "新描述",
            "image_path": None,
            "spec": {"note": "edited"},
        },
    ).json()

    assert updated["kind"] == "prop"
    assert updated["name"] == "新道具"
    assert updated["description"] == "新描述"
    assert updated["image_path"] is None
    assert updated["scope"] == "fixed"
    assert updated["spec"]["asset_scope"] == "fixed"
    assert updated["spec"]["note"] == "edited"


def test_project_asset_isolation(client) -> None:
    project_a = client.post("/api/projects", json={"title": "A"}).json()
    project_b = client.post("/api/projects", json={"title": "B"}).json()

    asset = client.post(
        f"/api/projects/{project_a['uid']}/assets",
        json={"kind": "character", "name": "A-only"},
    ).json()

    assert (
        client.get(f"/api/projects/{project_a['uid']}/assets").json()[0]["id"]
        == asset["id"]
    )
    assert client.get(f"/api/projects/{project_b['uid']}/assets").json() == []
    assert (
        client.get(f"/api/projects/{project_b['uid']}/assets/{asset['id']}").status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/projects/{project_b['uid']}/assets/{asset['id']}"
        ).status_code
        == 404
    )


def test_global_assets_are_visible_to_projects_and_episodes(client) -> None:
    global_asset = client.post(
        "/api/assets",
        json={"kind": "scene", "name": "通用雨夜街道", "image_path": "street.png"},
    ).json()
    project = client.post("/api/projects", json={"title": "P"}).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()

    assert global_asset["project_id"] is None
    assert global_asset["episode_id"] is None
    assert global_asset["scope"] == "global"
    assert client.get(f"/api/projects/{project['uid']}/assets").json()[0]["id"] == global_asset["id"]
    assert client.get(f"/api/episodes/{episode['id']}/assets").json()[0]["id"] == global_asset["id"]


def test_episode_temporary_asset_is_visible_only_in_that_episode(client) -> None:
    project = client.post("/api/projects", json={"title": "P"}).json()
    episode_a = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    episode_b = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 2, "title": "EP02"},
    ).json()

    asset = client.post(
        f"/api/episodes/{episode_a['id']}/assets",
        json={"kind": "prop", "name": "本集信物", "image_path": "token.png"},
    ).json()

    assert asset["project_id"] == project["id"]
    assert asset["episode_id"] == episode_a["id"]
    assert asset["scope"] == "temporary"
    assert [a["id"] for a in client.get(f"/api/episodes/{episode_a['id']}/assets").json()] == [asset["id"]]
    assert client.get(f"/api/episodes/{episode_b['id']}/assets").json() == []
    assert client.get(f"/api/projects/{project['uid']}/assets").json() == []


def test_temporary_asset_can_be_updated_and_deleted(client) -> None:
    project = client.post("/api/projects", json={"title": "P"}).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    asset = client.post(
        f"/api/episodes/{episode['id']}/assets",
        json={"kind": "scene", "name": "临时场景", "image_path": "room.png"},
    ).json()

    updated = client.patch(
        f"/api/episodes/{episode['id']}/assets/{asset['id']}",
        json={"name": "修改后场景", "description": "只在本集使用"},
    ).json()

    assert updated["name"] == "修改后场景"
    assert updated["description"] == "只在本集使用"
    assert updated["scope"] == "temporary"
    assert (
        client.delete(f"/api/episodes/{episode['id']}/assets/{asset['id']}").status_code
        == 204
    )
    assert client.get(f"/api/episodes/{episode['id']}/assets").json() == []


def test_asset_can_point_to_a_source_asset(client) -> None:
    project = client.post("/api/projects", json={"title": "P"}).json()
    source = client.post(
        "/api/assets",
        json={"kind": "character", "name": "源角色", "image_path": "source.png"},
    ).json()

    linked = client.post(
        f"/api/projects/{project['uid']}/assets",
        json={
            "kind": "character",
            "name": "项目引用角色",
            "source_asset_id": source["id"],
        },
    ).json()

    assert linked["scope"] == "fixed"
    assert linked["source_asset_id"] == source["id"]
    assert linked["image_path"] == "source.png"


def test_global_asset_can_be_updated_and_deleted(client) -> None:
    asset = client.post(
        "/api/assets",
        json={"kind": "prop", "name": "共享雨伞", "image_path": "umbrella.png"},
    ).json()

    updated = client.patch(
        f"/api/assets/{asset['id']}",
        json={"kind": "scene", "name": "共享雨景"},
    ).json()

    assert updated["kind"] == "scene"
    assert updated["name"] == "共享雨景"
    assert updated["scope"] == "global"
    assert client.delete(f"/api/assets/{asset['id']}").status_code == 204
    assert client.get(f"/api/assets/{asset['id']}").status_code == 404


def test_missing_project_asset_returns_404(client) -> None:
    project_uid = client.post("/api/projects", json={"title": "P"}).json()["uid"]
    assert client.delete(f"/api/projects/{project_uid}/assets/9999").status_code == 404
