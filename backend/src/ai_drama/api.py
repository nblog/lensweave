"""FastAPI application: HTTP entrypoint for the frontend (docs/03 §3).

A thin shell over the service layer. Exposes project / asset / episode / canvas
/ segment resources plus the async video-generation job endpoints. On startup it
creates tables and re-attaches poll loops to any jobs left running (docs/03
§4.3). CORS is opened to the dev frontend origin from settings.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ai_drama import services
from ai_drama.config import get_settings
from ai_drama.db import SessionLocal, init_db
from ai_drama.model_catalog import VideoGenSettings, get_seedance_video_settings
from ai_drama.models import (
    AssetCreate,
    AssetRead,
    CanvasGraph,
    EpisodeCreate,
    EpisodeRead,
    JobRead,
    ProjectCreate,
    ProjectRead,
    SegmentRead,
    StoryboardJSON,
)
from ai_drama.services.jobs import ensure_clips_dir, ensure_images_dir


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_db()
    ensure_clips_dir()
    await services.resume_running_jobs()
    yield


class VideoJobSubmit(BaseModel):
    """Request to run a VIDEO_GEN node from an episode canvas."""

    output_node_id: str
    channel: str = "mock"


class TextJobSubmit(BaseModel):
    """Request to run a TEXT_GEN node from an episode canvas."""

    output_node_id: str
    channel: str = "mock"


class ImageJobSubmit(BaseModel):
    """Request to run an IMAGE_GEN node from an episode canvas."""

    output_node_id: str
    channel: str = "mock"


def require_project_by_uid(db: Session, project_uid: str):
    project = services.get_project_by_uid(db, project_uid)
    if project is None:
        raise HTTPException(404, "project not found")
    return project


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="AI Drama Flow", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Serve generated media so the frontend can preview node outputs.
    app.mount("/clips", StaticFiles(directory=str(ensure_clips_dir())), name="clips")
    app.mount("/images", StaticFiles(directory=str(ensure_images_dir())), name="images")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    # --- model catalog ---

    @app.get(
        "/api/model-catalog/seedance/video-settings",
        response_model=VideoGenSettings,
    )
    def seedance_video_settings() -> VideoGenSettings:
        return get_seedance_video_settings()

    # --- projects ---

    @app.post("/api/projects", response_model=ProjectRead, status_code=201)
    def create_project(data: ProjectCreate, db: Session = Depends(get_db)):
        return ProjectRead.model_validate(services.create_project(db, data))

    @app.get("/api/projects", response_model=list[ProjectRead])
    def list_projects(db: Session = Depends(get_db)):
        return [ProjectRead.model_validate(p) for p in services.list_projects(db)]

    @app.get("/api/projects/{project_uid}", response_model=ProjectRead)
    def get_project(project_uid: str, db: Session = Depends(get_db)):
        return ProjectRead.model_validate(require_project_by_uid(db, project_uid))

    # --- assets (project-owned) ---

    @app.post(
        "/api/projects/{project_uid}/assets",
        response_model=AssetRead,
        status_code=201,
    )
    def create_project_asset(
        project_uid: str, data: AssetCreate, db: Session = Depends(get_db)
    ):
        project = require_project_by_uid(db, project_uid)
        try:
            return AssetRead.model_validate(
                services.create_project_asset(db, project.id, data)
            )
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/projects/{project_uid}/assets", response_model=list[AssetRead])
    def list_project_assets(
        project_uid: str, kind: str | None = None, db: Session = Depends(get_db)
    ):
        project = require_project_by_uid(db, project_uid)
        try:
            return [
                AssetRead.model_validate(a)
                for a in services.list_project_assets(db, project.id, kind=kind)
            ]
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/projects/{project_uid}/assets/{asset_id}", response_model=AssetRead)
    def get_project_asset(
        project_uid: str, asset_id: int, db: Session = Depends(get_db)
    ):
        project = require_project_by_uid(db, project_uid)
        asset = services.get_project_asset(db, project.id, asset_id)
        if asset is None:
            raise HTTPException(404, "asset not found")
        return AssetRead.model_validate(asset)

    @app.delete("/api/projects/{project_uid}/assets/{asset_id}", status_code=204)
    def delete_project_asset(
        project_uid: str, asset_id: int, db: Session = Depends(get_db)
    ):
        project = require_project_by_uid(db, project_uid)
        try:
            services.delete_project_asset(db, project.id, asset_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    # --- episodes ---

    @app.post(
        "/api/projects/{project_uid}/episodes",
        response_model=EpisodeRead,
        status_code=201,
    )
    def create_episode(
        project_uid: str, data: EpisodeCreate, db: Session = Depends(get_db)
    ):
        project = require_project_by_uid(db, project_uid)
        try:
            return EpisodeRead.model_validate(
                services.create_episode(db, project.id, data)
            )
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/api/projects/{project_uid}/episodes", response_model=list[EpisodeRead])
    def list_episodes(project_uid: str, db: Session = Depends(get_db)):
        project = require_project_by_uid(db, project_uid)
        return [
            EpisodeRead.model_validate(e)
            for e in services.list_episodes(db, project.id)
        ]

    @app.put("/api/episodes/{episode_id}/storyboard", response_model=list[SegmentRead])
    def set_storyboard(
        episode_id: int, storyboard: StoryboardJSON, db: Session = Depends(get_db)
    ):
        try:
            services.set_storyboard(db, episode_id, storyboard)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        return [
            SegmentRead.model_validate(s)
            for s in services.list_segments(db, episode_id)
        ]

    @app.get("/api/episodes/{episode_id}/segments", response_model=list[SegmentRead])
    def list_segments(episode_id: int, db: Session = Depends(get_db)):
        return [
            SegmentRead.model_validate(s)
            for s in services.list_segments(db, episode_id)
        ]

    # --- canvas ---

    @app.get("/api/episodes/{episode_id}/canvas")
    def get_canvas(episode_id: int, db: Session = Depends(get_db)):
        graph = services.get_canvas(db, episode_id)
        if graph is None:
            # Return an empty graph for a fresh episode.
            return CanvasGraph(episode_id=episode_id).model_dump(mode="json")
        return graph.model_dump(mode="json")

    @app.put("/api/episodes/{episode_id}/canvas")
    def save_canvas(episode_id: int, graph: CanvasGraph, db: Session = Depends(get_db)):
        try:
            services.save_canvas(db, episode_id, graph)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        return {"status": "saved"}

    # --- generation jobs ---

    @app.post(
        "/api/episodes/{episode_id}/text", response_model=JobRead, status_code=202
    )
    async def submit_text(
        episode_id: int,
        body: TextJobSubmit,
        db: Session = Depends(get_db),
    ):
        if services.get_episode(db, episode_id) is None:
            raise HTTPException(404, "episode not found")
        graph = services.get_canvas(db, episode_id)
        if graph is None:
            raise HTTPException(400, "episode has no canvas")

        try:
            request = services.compile_text_request(
                graph, output_node_id=body.output_node_id
            )
        except services.CompileError as exc:
            raise HTTPException(400, str(exc)) from exc

        job = await services.generate_text_job(
            db,
            episode_id=episode_id,
            output_node_id=body.output_node_id,
            request=request,
            channel=body.channel,
        )
        return JobRead.model_validate(job)

    @app.post(
        "/api/episodes/{episode_id}/image", response_model=JobRead, status_code=202
    )
    async def submit_image(
        episode_id: int,
        body: ImageJobSubmit,
        db: Session = Depends(get_db),
    ):
        episode = services.get_episode(db, episode_id)
        if episode is None:
            raise HTTPException(404, "episode not found")
        graph = services.get_canvas(db, episode_id)
        if graph is None:
            raise HTTPException(400, "episode has no canvas")

        def image_for_asset(ref_id: int | None) -> str | None:
            if ref_id is None:
                return None
            asset = services.get_project_asset(db, episode.project_id, ref_id)
            if asset is None:
                raise services.CompileError(
                    f"asset {ref_id} does not belong to this project"
                )
            return asset.image_path

        try:
            request = services.compile_image_request(
                graph,
                output_node_id=body.output_node_id,
                resolve_asset_image=image_for_asset,
            )
        except services.CompileError as exc:
            raise HTTPException(400, str(exc)) from exc

        job = await services.generate_image_job(
            db,
            episode_id=episode_id,
            output_node_id=body.output_node_id,
            request=request,
            channel=body.channel,
        )
        return JobRead.model_validate(job)

    @app.post(
        "/api/episodes/{episode_id}/video", response_model=JobRead, status_code=202
    )
    def submit_episode_video(
        episode_id: int,
        body: VideoJobSubmit,
        background: BackgroundTasks,
        db: Session = Depends(get_db),
    ):
        episode = services.get_episode(db, episode_id)
        if episode is None:
            raise HTTPException(404, "episode not found")
        graph = services.get_canvas(db, episode_id)
        if graph is None:
            raise HTTPException(400, "episode has no canvas")

        def image_for_asset(ref_id: int | None) -> str | None:
            if ref_id is None:
                return None
            asset = services.get_project_asset(db, episode.project_id, ref_id)
            if asset is None:
                raise services.CompileError(
                    f"asset {ref_id} does not belong to this project"
                )
            return asset.image_path

        try:
            request = services.compile_video_request(
                graph,
                output_node_id=body.output_node_id,
                resolve_asset_image=image_for_asset,
            )
        except services.CompileError as exc:
            raise HTTPException(400, str(exc)) from exc

        job = services.create_video_job(
            db,
            target_table="episode",
            target_id=episode_id,
            output_node_id=body.output_node_id,
            request=request,
            channel=body.channel,
        )
        background.add_task(services.run_video_job, job.id)
        return JobRead.model_validate(job)

    @app.post(
        "/api/segments/{segment_id}/video", response_model=JobRead, status_code=202
    )
    def submit_video(
        segment_id: int,
        body: VideoJobSubmit,
        background: BackgroundTasks,
        db: Session = Depends(get_db),
    ):
        segment = services.get_segment(db, segment_id)
        if segment is None:
            raise HTTPException(404, "segment not found")
        graph = services.get_canvas(db, segment.episode_id)
        if graph is None:
            raise HTTPException(400, "episode has no canvas")

        def image_for_asset(ref_id: int | None) -> str | None:
            if ref_id is None:
                return None
            asset = services.get_project_asset(db, segment.episode.project_id, ref_id)
            if asset is None:
                raise services.CompileError(
                    f"asset {ref_id} does not belong to this project"
                )
            return asset.image_path

        try:
            request = services.compile_video_request(
                graph,
                output_node_id=body.output_node_id,
                resolve_asset_image=image_for_asset,
            )
        except services.CompileError as exc:
            raise HTTPException(400, str(exc)) from exc

        job = services.create_video_job(
            db,
            target_table="segment",
            target_id=segment_id,
            output_node_id=body.output_node_id,
            request=request,
            channel=body.channel,
        )
        background.add_task(services.run_video_job, job.id)
        return JobRead.model_validate(job)

    @app.get("/api/jobs/{job_id}", response_model=JobRead)
    def get_job(job_id: str, db: Session = Depends(get_db)):
        job = services.get_job(db, job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        return JobRead.model_validate(job)

    return app


app = create_app()
