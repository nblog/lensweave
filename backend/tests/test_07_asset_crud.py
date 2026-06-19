"""Project-owned asset CRUD over HTTP.

Assets are created under a project UID, listed only from that project, and can
only be fetched or deleted through their owning project path.
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


def test_missing_project_asset_returns_404(client) -> None:
    project_uid = client.post("/api/projects", json={"title": "P"}).json()["uid"]
    assert client.delete(f"/api/projects/{project_uid}/assets/9999").status_code == 404
