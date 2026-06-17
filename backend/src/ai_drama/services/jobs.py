"""Generation-job service — async submit/poll/resume (docs/03 §4).

Implements the lightweight task model of ADR-003: submit to the adapter, persist
job state in the DB, then run a poll loop (as a FastAPI BackgroundTask or a CLI
foreground loop) that drives the job to a terminal state and, on success,
downloads the clip and records its path on the target segment. ``provider_task_id``
is persisted so an interrupted loop can be resumed without losing the task
(docs/03 §4.3).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_drama.adapters.base import ImageGenRequest, TextGenRequest, VideoGenRequest
from ai_drama.adapters.registry import (
    get_image_adapter,
    get_text_adapter,
    get_video_adapter,
)
from ai_drama.config import GENERATED_CLIPS_DIR, GENERATED_IMAGES_DIR
from ai_drama.db import GenerationJob, Segment, SessionLocal
from ai_drama.models import JobStatus

# Where downloaded clips land. Mirrors the project ``outputs/`` convention.
CLIPS_DIR = GENERATED_CLIPS_DIR
IMAGES_DIR = GENERATED_IMAGES_DIR
logger = logging.getLogger(__name__)


def _create_job(
    db: Session,
    *,
    kind: str,
    target_table: str,
    target_id: int,
    request: dict,
) -> GenerationJob:
    job = GenerationJob(
        id=str(uuid.uuid4()),
        kind=kind,
        status=JobStatus.QUEUED.value,
        target_table=target_table,
        target_id=target_id,
        request=request,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def create_video_job(
    db: Session,
    *,
    segment_id: int,
    request: VideoGenRequest,
    channel: str = "mock",
) -> GenerationJob:
    """Create a queued video job targeting a segment. Does not start polling."""
    if db.get(Segment, segment_id) is None:
        raise LookupError(f"segment {segment_id} not found")
    return _create_job(
        db,
        kind="video",
        target_table="segment",
        target_id=segment_id,
        request={"channel": channel, **request.model_dump(mode="json")},
    )


def get_job(db: Session, job_id: str) -> GenerationJob | None:
    return db.get(GenerationJob, job_id)


async def generate_text_job(
    db: Session,
    *,
    episode_id: int,
    output_node_id: str,
    request: TextGenRequest,
    channel: str = "mock",
) -> GenerationJob:
    """Run a synchronous text generation and persist it as a completed job."""
    job = _create_job(
        db,
        kind="text",
        target_table="episode",
        target_id=episode_id,
        request={
            "channel": channel,
            "output_node_id": output_node_id,
            **request.model_dump(mode="json"),
        },
    )
    adapter = get_text_adapter(channel)
    job.status = JobStatus.RUNNING.value
    db.commit()
    try:
        result = await adapter.generate(request)
    except Exception as exc:  # noqa: BLE001
        logger.exception("text job %s failed for node %s", job.id, output_node_id)
        _mark(db, job, JobStatus.FAILED, error=str(exc))
    else:
        job.status = JobStatus.SUCCEEDED.value
        job.result = result.model_dump(mode="json")
        db.commit()
        logger.info("text job %s succeeded for node %s", job.id, output_node_id)
    db.refresh(job)
    return job


async def generate_image_job(
    db: Session,
    *,
    episode_id: int,
    output_node_id: str,
    request: ImageGenRequest,
    channel: str = "mock",
) -> GenerationJob:
    """Run a synchronous image generation and persist it as a completed job."""
    job = _create_job(
        db,
        kind="image",
        target_table="episode",
        target_id=episode_id,
        request={
            "channel": channel,
            "output_node_id": output_node_id,
            **request.model_dump(mode="json"),
        },
    )
    adapter = get_image_adapter(channel)
    job.status = JobStatus.RUNNING.value
    db.commit()
    out = IMAGES_DIR / f"{episode_id}_{safe_node_id(output_node_id)}_{job.id}"
    try:
        result = await adapter.generate(request, out=out)
    except Exception as exc:  # noqa: BLE001
        logger.exception("image job %s failed for node %s", job.id, output_node_id)
        _mark(db, job, JobStatus.FAILED, error=str(exc))
    else:
        image_path = result.image_path
        job.status = JobStatus.SUCCEEDED.value
        job.result = {
            **result.model_dump(mode="json"),
            "image_url": image_url(image_path),
        }
        db.commit()
        logger.info(
            "image job %s succeeded for node %s -> %s",
            job.id,
            output_node_id,
            image_path,
        )
    db.refresh(job)
    return job


async def run_video_job(job_id: str, *, interval: float = 2.0) -> None:
    """Drive a video job to terminal state. Safe to run as a BackgroundTask.

    Uses its own session so it is independent of any request-scoped session.
    Reuses the channel and request captured at creation time; on success
    downloads the clip and writes ``clip_path`` onto the target segment.
    """
    with SessionLocal() as db:
        job = db.get(GenerationJob, job_id)
        if job is None:
            return
        channel = job.request.get("channel", "mock")
        adapter = get_video_adapter(channel)
        req = VideoGenRequest.model_validate(
            {k: v for k, v in job.request.items() if k != "channel"}
        )

        # Submit (only if not already submitted — supports resume).
        if not job.provider_task_id:
            try:
                submit = await adapter.submit(req)
            except Exception as exc:  # noqa: BLE001 — record and fail the job
                _mark(db, job, JobStatus.FAILED, error=str(exc))
                return
            job.provider_task_id = submit.provider_task_id
            job.status = JobStatus.RUNNING.value
            db.commit()

        await _poll_until_done(db, job, adapter, interval=interval)


async def resume_running_jobs() -> int:
    """Re-attach poll loops to jobs left ``running`` (startup recovery).

    Returns the number of jobs whose polling was resumed. The task itself never
    stopped server-side; only the local loop is reconnected (docs/03 §4.3).
    """
    with SessionLocal() as db:
        stmt = select(GenerationJob).where(
            GenerationJob.status == JobStatus.RUNNING.value
        )
        job_ids = [j.id for j in db.scalars(stmt)]
    for jid in job_ids:
        asyncio.create_task(run_video_job(jid))
    return len(job_ids)


async def _poll_until_done(db, job, adapter, *, interval: float) -> None:
    while True:
        try:
            poll = await adapter.poll(job.provider_task_id)
        except Exception as exc:  # noqa: BLE001
            _mark(db, job, JobStatus.FAILED, error=str(exc))
            return

        if poll.status == "succeeded":
            clip_path = None
            if poll.video_url:
                out = CLIPS_DIR / f"{job.target_id}_{job.id}.mp4"
                try:
                    saved = await adapter.download(poll.video_url, out)
                    clip_path = str(saved)
                except Exception as exc:  # noqa: BLE001
                    _mark(db, job, JobStatus.FAILED, error=f"download failed: {exc}")
                    return
            _on_success(db, job, clip_path=clip_path, video_url=poll.video_url)
            return
        if poll.status in {"failed", "canceled"}:
            status = (
                JobStatus.FAILED if poll.status == "failed" else JobStatus.CANCELED
            )
            _mark(db, job, status, error=poll.error)
            return

        # still running/queued
        if job.status != JobStatus.RUNNING.value:
            job.status = JobStatus.RUNNING.value
            db.commit()
        await asyncio.sleep(interval)


def _on_success(db, job, *, clip_path: str | None, video_url: str | None) -> None:
    job.status = JobStatus.SUCCEEDED.value
    job.result = {"video_url": video_url, "clip_path": clip_path}
    if clip_path is not None:
        segment = db.get(Segment, job.target_id)
        if segment is not None:
            segment.clip_path = clip_path
    db.commit()


def _mark(db, job, status: JobStatus, *, error: str | None = None) -> None:
    job.status = status.value
    job.error = error
    db.commit()


def ensure_clips_dir() -> Path:
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    return CLIPS_DIR


def ensure_images_dir() -> Path:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    return IMAGES_DIR


def image_url(image_path: str) -> str:
    name = Path(image_path).name
    return f"/images/{name}"


def safe_node_id(node_id: str) -> str:
    return "".join(c if c.isalnum() or c in {"-", "_"} else "_" for c in node_id)
