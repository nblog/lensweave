"""Asset library CRUD over HTTP (docs/04 §2.4, ADR-005).

Covers the global asset surface the frontend now drives: an asset carries an
optional ``description`` alongside its required name, and can be deleted
(``DELETE /api/assets/{id}``). Deletion must succeed even when projects still
reference the asset — the service clears the ``project_asset`` association
first — and a second delete returns 404. Locks the behavior added for the
asset-library rework.
"""

from __future__ import annotations


def test_create_asset_with_description(client) -> None:
    asset = client.post(
        "/api/assets",
        json={
            "kind": "character",
            "name": "女主·林夏",
            "description": "短发，红色卫衣",
            "image_path": "data:image/png;base64,AAAA",
        },
    ).json()

    assert asset["description"] == "短发，红色卫衣"
    assert asset["name"] == "女主·林夏"

    fetched = client.get(f"/api/assets/{asset['id']}").json()
    assert fetched["description"] == "短发，红色卫衣"


def test_description_defaults_to_null(client) -> None:
    asset = client.post(
        "/api/assets", json={"kind": "prop", "name": "雨伞"}
    ).json()
    assert asset["description"] is None


def test_delete_asset_referenced_by_project(client) -> None:
    pid = client.post("/api/projects", json={"title": "P"}).json()["id"]
    asset = client.post(
        "/api/assets", json={"kind": "scene", "name": "前院"}
    ).json()
    aid = asset["id"]

    # Reference it from a project, then delete the global asset.
    assert client.post(f"/api/projects/{pid}/assets/{aid}").status_code == 204
    assert client.delete(f"/api/assets/{aid}").status_code == 204

    # Gone from the library and no longer referenced by the project.
    assert client.get(f"/api/assets/{aid}").status_code == 404
    assert client.get(f"/api/projects/{pid}/assets").json() == []


def test_delete_missing_asset_returns_404(client) -> None:
    assert client.delete("/api/assets/9999").status_code == 404
