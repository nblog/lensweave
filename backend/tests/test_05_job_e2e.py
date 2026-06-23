"""End-to-end job test over HTTP with the mock channel (docs/05 §2 test/05_job).

Drives the full vertical through the API: create project → project asset →
episode → canvas, submit a video job, poll until it succeeds, and confirm the
clip path is returned in the job result. Runs fully offline via the mock channel,
so it never touches a real provider or burns tokens. The isolated-DB ``client``
fixture lives in conftest.
"""

from __future__ import annotations

import asyncio
import time


def test_canvas_position_size_round_trips_over_http(client) -> None:
    project = client.post("/api/projects", json={"title": "Canvas Geometry"}).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()

    canvas = {
        "episode_id": episode["id"],
        "nodes": [
            {
                "id": "txt",
                "kind": "text",
                "position": {"x": 12, "y": 34, "width": 420, "height": 220},
                "data": {"visual_prompt": "wide prompt"},
            },
        ],
        "edges": [],
    }

    assert (
        client.put(f"/api/episodes/{episode['id']}/canvas", json=canvas).status_code
        == 200
    )

    saved = client.get(f"/api/episodes/{episode['id']}/canvas").json()

    assert saved["nodes"][0]["position"] == {
        "x": 12.0,
        "y": 34.0,
        "width": 420.0,
        "height": 220.0,
    }


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
    assert "is not visible in this episode" in submit.text


def test_episode_video_accepts_global_and_current_episode_assets(client) -> None:
    project = client.post("/api/projects", json={"title": "Layered"}).json()
    global_asset = client.post(
        "/api/assets",
        json={"kind": "scene", "name": "全局街道", "image_path": "global.png"},
    ).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    temp_asset = client.post(
        f"/api/episodes/{episode['id']}/assets",
        json={"kind": "prop", "name": "本集纸条", "image_path": "note.png"},
    ).json()

    canvas = {
        "episode_id": episode["id"],
        "nodes": [
            {"id": "global", "kind": "image", "ref_id": global_asset["id"]},
            {"id": "temp", "kind": "image", "ref_id": temp_asset["id"]},
            {"id": "txt", "kind": "text", "data": {"visual_prompt": "street clue"}},
            {"id": "vg", "kind": "video_gen"},
        ],
        "edges": [
            {"id": "e1", "source": "global", "target": "vg", "order": 1},
            {"id": "e2", "source": "temp", "target": "vg", "order": 2},
            {"id": "e3", "source": "txt", "target": "vg", "order": 3},
        ],
    }
    assert (
        client.put(f"/api/episodes/{episode['id']}/canvas", json=canvas).status_code
        == 200
    )

    submit = client.post(
        f"/api/episodes/{episode['id']}/video",
        json={"output_node_id": "vg", "channel": "mock"},
    )
    assert submit.status_code == 202


def test_episode_video_rejects_temporary_asset_from_another_episode(client) -> None:
    project = client.post("/api/projects", json={"title": "Layered"}).json()
    episode_a = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()
    episode_b = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 2, "title": "EP02"},
    ).json()
    temp_asset = client.post(
        f"/api/episodes/{episode_b['id']}/assets",
        json={"kind": "prop", "name": "EP02-only", "image_path": "ep2.png"},
    ).json()

    canvas = {
        "episode_id": episode_a["id"],
        "nodes": [
            {"id": "img", "kind": "image", "ref_id": temp_asset["id"]},
            {"id": "txt", "kind": "text", "data": {"visual_prompt": "courtyard"}},
            {"id": "vg", "kind": "video_gen"},
        ],
        "edges": [
            {"id": "e1", "source": "img", "target": "vg", "order": 1},
            {"id": "e2", "source": "txt", "target": "vg", "order": 2},
        ],
    }
    assert (
        client.put(f"/api/episodes/{episode_a['id']}/canvas", json=canvas).status_code
        == 200
    )

    submit = client.post(
        f"/api/episodes/{episode_a['id']}/video",
        json={"output_node_id": "vg", "channel": "mock"},
    )
    assert submit.status_code == 400
    assert "is not visible in this episode" in submit.text


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


def test_resume_running_jobs_ignores_non_video_jobs(client) -> None:
    project = client.post("/api/projects", json={"title": "Resume Guard"}).json()
    episode = client.post(
        f"/api/projects/{project['uid']}/episodes",
        json={"episode_no": 1, "title": "EP01"},
    ).json()

    from ai_drama.db import GenerationJob, SessionLocal
    from ai_drama import services

    with SessionLocal() as db:
        job = GenerationJob(
            id="running-image-job",
            kind="image",
            status="running",
            target_table="episode",
            target_id=episode["id"],
            request={
                "channel": "mock",
                "output_node_id": "image_gen-1",
                "ordered_content": [
                    {"type": "text", "text": "still image only", "image": None}
                ],
            },
        )
        db.add(job)
        db.commit()

    assert asyncio.run(services.resume_running_jobs()) == 0

    with SessionLocal() as db:
        job = db.get(GenerationJob, "running-image-job")
        assert job is not None
        assert job.kind == "image"
        assert job.provider_task_id is None
        assert job.result is None
