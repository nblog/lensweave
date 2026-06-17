"""End-to-end job test over HTTP with the mock channel (docs/05 §2 test/05_job).

Drives the full vertical through the API: create project → global asset →
episode → storyboard → canvas, submit a video job, poll until it succeeds, and
confirm a clip path is recorded on the segment. Runs fully offline via the mock
channel, so it never touches a real provider or burns tokens. The isolated-DB
``client`` fixture lives in conftest.
"""

from __future__ import annotations

import time


def test_single_segment_render_e2e(client) -> None:
    project = client.post("/api/projects", json={"title": "E2E"}).json()
    pid = project["id"]

    # Global asset, then reference it from the project.
    char = client.post(
        "/api/assets",
        json={"kind": "character", "name": "女主", "image_path": "char.png"},
    ).json()
    assert (
        client.post(f"/api/projects/{pid}/assets/{char['id']}").status_code == 204
    )

    episode = client.post(
        f"/api/projects/{pid}/episodes",
        json={"episode_no": 1, "title": "EP01", "total_duration_sec": 6},
    ).json()
    eid = episode["id"]

    segments = client.put(
        f"/api/episodes/{eid}/storyboard",
        json={
            "episode_id": eid,
            "title": "EP01",
            "total_duration_sec": 6,
            "segments": [
                {"segment_id": 1, "duration_sec": 6, "visual_prompt": "courtyard"}
            ],
        },
    ).json()
    assert len(segments) == 1
    seg_id = segments[0]["id"]

    canvas = {
        "episode_id": eid,
        "nodes": [
            {"id": "img", "kind": "image", "ref_id": char["id"]},
            {
                "id": "txt",
                "kind": "text",
                "ref_id": seg_id,
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
        f"/api/segments/{seg_id}/video",
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

    # Segment should now carry the clip path.
    seg = client.get(f"/api/episodes/{eid}/segments").json()[0]
    assert seg["clip_path"]


def test_text_and_image_generation_jobs_over_http(client) -> None:
    project = client.post("/api/projects", json={"title": "Text Image"}).json()
    episode = client.post(
        f"/api/projects/{project['id']}/episodes",
        json={"episode_no": 1, "title": "EP01", "total_duration_sec": 6},
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
