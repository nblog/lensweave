"""Project / Asset / Episode / Canvas / Segment CRUD services.

Transport-agnostic business logic (docs/03 §1): functions take a session plus
typed inputs and return ORM rows or pydantic models, reachable from both the
HTTP API and the CLI. Cross-entity consistency checks live here (e.g. an asset
or canvas must belong to an existing project / episode).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_drama.db import Asset, Episode, Project, Segment
from ai_drama.models import (
    AssetCreate,
    CanvasGraph,
    EpisodeCreate,
    ProjectCreate,
    StoryboardJSON,
)


# --- project ---


def create_project(db: Session, data: ProjectCreate) -> Project:
    project = Project(title=data.title)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def list_projects(db: Session) -> list[Project]:
    return list(db.scalars(select(Project).order_by(Project.id.desc())))


def get_project(db: Session, project_id: int) -> Project | None:
    return db.get(Project, project_id)


def get_project_by_uid(db: Session, project_uid: str) -> Project | None:
    return db.scalar(select(Project).where(Project.uid == project_uid))


# --- asset (project-owned) ---


def create_project_asset(db: Session, project_id: int, data: AssetCreate) -> Asset:
    """Create an asset owned by one project."""
    if db.get(Project, project_id) is None:
        raise LookupError(f"project {project_id} not found")
    asset = Asset(
        project_id=project_id,
        kind=data.kind.value,
        name=data.name,
        description=data.description,
        spec=data.spec,
        image_path=data.image_path,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


def list_project_assets(
    db: Session, project_id: int, *, kind: str | None = None
) -> list[Asset]:
    """List assets owned by a project."""
    if db.get(Project, project_id) is None:
        raise LookupError(f"project {project_id} not found")
    stmt = select(Asset).where(Asset.project_id == project_id).order_by(Asset.id)
    if kind is not None:
        stmt = stmt.where(Asset.kind == kind)
    return list(db.scalars(stmt))


def get_project_asset(db: Session, project_id: int, asset_id: int) -> Asset | None:
    stmt = select(Asset).where(Asset.id == asset_id, Asset.project_id == project_id)
    return db.scalar(stmt)


def delete_project_asset(db: Session, project_id: int, asset_id: int) -> None:
    """Delete an asset only when it belongs to the given project."""
    asset = get_project_asset(db, project_id, asset_id)
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in project {project_id}")
    db.delete(asset)
    db.commit()


# --- episode ---


def create_episode(db: Session, project_id: int, data: EpisodeCreate) -> Episode:
    if db.get(Project, project_id) is None:
        raise LookupError(f"project {project_id} not found")
    episode = Episode(
        project_id=project_id,
        episode_no=data.episode_no,
        title=data.title,
    )
    db.add(episode)
    db.commit()
    db.refresh(episode)
    return episode


def list_episodes(db: Session, project_id: int) -> list[Episode]:
    stmt = (
        select(Episode)
        .where(Episode.project_id == project_id)
        .order_by(Episode.episode_no)
    )
    return list(db.scalars(stmt))


def get_episode(db: Session, episode_id: int) -> Episode | None:
    return db.get(Episode, episode_id)


# --- storyboard / segments ---


def set_storyboard(db: Session, episode_id: int, storyboard: StoryboardJSON) -> Episode:
    """Persist a validated storyboard and materialize its segments.

    The pydantic ``StoryboardJSON`` owns only per-storyboard invariants here;
    episode total duration is intentionally not modeled at this slice. We store
    the document and fan out one Segment row per shot so each can be referenced
    by a canvas node and carry its own clip path when the segmented pipeline is
    active.
    """
    episode = db.get(Episode, episode_id)
    if episode is None:
        raise LookupError(f"episode {episode_id} not found")

    episode.storyboard = storyboard.model_dump()
    # Replace existing segments (idempotent re-runs).
    for existing in list(episode.segments):
        db.delete(existing)
    for seg in storyboard.segments:
        db.add(
            Segment(
                episode_id=episode_id,
                segment_id=seg.segment_id,
                duration_sec=seg.duration_sec,
                spec=seg.model_dump(),
            )
        )
    db.commit()
    db.refresh(episode)
    return episode


def list_segments(db: Session, episode_id: int) -> list[Segment]:
    stmt = (
        select(Segment)
        .where(Segment.episode_id == episode_id)
        .order_by(Segment.segment_id)
    )
    return list(db.scalars(stmt))


def get_segment(db: Session, segment_id: int) -> Segment | None:
    return db.get(Segment, segment_id)


# --- canvas ---


def save_canvas(db: Session, episode_id: int, graph: CanvasGraph) -> Episode:
    """Persist the EP canvas graph (topology already validated by pydantic)."""
    episode = db.get(Episode, episode_id)
    if episode is None:
        raise LookupError(f"episode {episode_id} not found")
    episode.canvas = graph.model_dump(mode="json")
    db.commit()
    db.refresh(episode)
    return episode


def get_canvas(db: Session, episode_id: int) -> CanvasGraph | None:
    episode = db.get(Episode, episode_id)
    if episode is None or episode.canvas is None:
        return None
    return CanvasGraph.model_validate(episode.canvas)
