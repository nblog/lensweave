"""End-to-end job test over HTTP with the mock channel (docs/05 §2 test/05_job).

Drives the full vertical through the API: create project → project asset →
episode → canvas, submit a video job, poll until it succeeds, and confirm the
clip path is returned in the job result. Runs fully offline via the mock channel,
so it never touches a real provider or burns tokens. The isolated-DB ``client``
fixture lives in conftest.
"""

from __future__ import annotations

import time


def test_episode_video_render_e2e_without_segments(client) -> None:
    project = client.post("/api/projects", json={"title": "E2E"}).json()
    project_uid = project["uid"]

    char = client.post(
        f"/api/projects/{project_uid}/assets",
        json={"kind": "character", "name": "女主", "image_path": "char.png"},
    ).json()

    episode = client.post(
        f"/api/projects/{project_uid}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    eid = episode["id"]

    canvas = {
        "episode_id": eid,
        "nodes": [
            {"id": "img", "kind": "image", "ref_id": char["id"]},
            {
                "id": "txt",
                "kind": "text",
                "data": {"visual_prompt": "courtyard"},
            },
            {"id": "vg", "kind": "video_gen"},
        ],
        "edges": [
            {"id": "e1", "source": "img", "target": "vg", "order": 1},
            {"id": "e2", "source": "txt", "target": "vg", "order": 2},
        ],
    }
    assert client.put(f"/api/episodes/{eid}/canvas", json=canvas).status_code == 200

    submit = client.post(
        f"/api/episodes/{eid}/video",
        json={"output_node_id": "vg", "channel": "mock"},
    )
    assert submit.status_code == 202
    job_id = submit.json()["id"]

    # Poll until terminal (mock resolves within a couple of polls).
    status = None
    for _ in range(50):
        job = client.get(f"/api/jobs/{job_id}").json()
        status = job["status"]
        if status in {"succeeded", "failed", "canceled"}:
            break
        time.sleep(0.1)

    assert status == "succeeded", job
    assert job["result"]["clip_path"]

    # Episode-level video jobs do not require or create segments.
    assert client.get(f"/api/episodes/{eid}/segments").json() == []


def test_episode_video_rejects_asset_from_another_project(client) -> None:
    project_a = client.post("/api/projects", json={"title": "A"}).json()
    project_b = client.post("/api/projects", json={"title": "B"}).json()
    foreign_asset = client.post(
        f"/api/projects/{project_b['uid']}/assets",
        json={"kind": "character", "name": "B asset", "image_path": "b.png"},
    ).json()

    episode = client.post(
        f"/api/projects/{project_a['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    eid = episode["id"]

    canvas = {
        "episode_id": eid,
        "nodes": [
            {"id": "img", "kind": "image", "ref_id": foreign_asset["id"]},
            {"id": "txt", "kind": "text", "data": {"visual_prompt": "courtyard"}},
            {"id": "vg", "kind": "video_gen"},
        ],
        "edges": [
            {"id": "e1", "source": "img", "target": "vg", "order": 1},
            {"id": "e2", "source": "txt", "target": "vg", "order": 2},
        ],
    }
    assert client.put(f"/api/episodes/{eid}/canvas", json=canvas).status_code == 200

    submit = client.post(
        f"/api/episodes/{eid}/video",
        json={"output_node_id": "vg", "channel": "mock"},
    )
    assert submit.status_code == 400
    assert "does not belong to this project" in submit.text


def test_text_and_image_generation_jobs_over_http(client) -> None:
    project = client.post("/api/projects", json={"title": "Text Image"}).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    eid = episode["id"]

    canvas = {
        "episode_id": eid,
        "nodes": [
            {
                "id": "txt",
                "kind": "text",
                "data": {"visual_prompt": "a red lantern in rain"},
            },
            {"id": "tg", "kind": "text_gen"},
            {"id": "ig", "kind": "image_gen"},
        ],
        "edges": [
            {"id": "e1", "source": "txt", "target": "tg", "order": 1},
            {"id": "e2", "source": "txt", "target": "ig", "order": 1},
        ],
    }
    assert client.put(f"/api/episodes/{eid}/canvas", json=canvas).status_code == 200

    text_job = client.post(
        f"/api/episodes/{eid}/text",
        json={"output_node_id": "tg", "channel": "mock"},
    )
    assert text_job.status_code == 202
    text_body = text_job.json()
    assert text_body["status"] == "succeeded"
    assert text_body["result"]["text"].startswith("[mock text]")

    image_job = client.post(
        f"/api/episodes/{eid}/image",
        json={"output_node_id": "ig", "channel": "mock"},
    )
    assert image_job.status_code == 202
    image_body = image_job.json()
    assert image_body["status"] == "succeeded"
    assert image_body["result"]["image_url"].startswith("/images/")
