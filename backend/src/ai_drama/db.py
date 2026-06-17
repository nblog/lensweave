"""SQLAlchemy ORM layer: declarative base, engine/session, and persistence models.

Implements the data model of docs/01 §3 for the current vertical slice:
Project → Asset / Episode → Segment, plus the standalone GenerationJob table.
Whole-document stage outputs (storyboard, canvas, asset spec) are stored as JSON
columns per docs/01 §3.1; Segment is its own table because it is referenced by
canvas nodes, carries panel/clip paths, and runs its own generation job.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    ForeignKey,
    String,
    Table,
    create_engine,
    func,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
    sessionmaker,
)

from ai_drama.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


# Project ↔ Asset many-to-many association (ADR-005): assets are global and a
# project references them rather than owning them.
project_asset = Table(
    "project_asset",
    Base.metadata,
    Column("project_id", ForeignKey("project.id"), primary_key=True),
    Column("asset_id", ForeignKey("asset.id"), primary_key=True),
)


class Project(Base):
    """A single drama production. Owns episodes; references global assets."""

    __tablename__ = "project"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    story_digest: Mapped[dict | None] = mapped_column(JSON, default=None)
    character_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    world_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    episode_map: Mapped[dict | None] = mapped_column(JSON, default=None)

    assets: Mapped[list["Asset"]] = relationship(
        secondary=project_asset, back_populates="projects"
    )
    episodes: Mapped[list["Episode"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Asset(Base):
    """A global visual asset (character / prop / scene); 04/05 output (ADR-005).

    Not owned by any project — referenced via the ``project_asset`` association.
    ``source_project_id`` records which project's 02 Bible first generated it
    (nullable for hand-created global assets).
    """

    __tablename__ = "asset"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    spec: Mapped[dict] = mapped_column(JSON, default=dict)
    image_path: Mapped[str | None] = mapped_column(default=None)
    source_project_id: Mapped[int | None] = mapped_column(
        ForeignKey("project.id"), default=None
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    projects: Mapped[list["Project"]] = relationship(
        secondary=project_asset, back_populates="assets"
    )


class Episode(Base):
    """An episode. Owns its segments, storyboard JSON, and canvas graph."""

    __tablename__ = "episode"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("project.id"))
    episode_no: Mapped[int]
    title: Mapped[str] = mapped_column(String(200))
    total_duration_sec: Mapped[int]
    script: Mapped[dict | None] = mapped_column(JSON, default=None)
    storyboard: Mapped[dict | None] = mapped_column(JSON, default=None)
    canvas: Mapped[dict | None] = mapped_column(JSON, default=None)

    project: Mapped["Project"] = relationship(back_populates="episodes")
    segments: Mapped[list["Segment"]] = relationship(
        back_populates="episode", cascade="all, delete-orphan"
    )


class Segment(Base):
    """A ≤15s shot fragment; the pipeline's minimal unit (test/instructions/06).

    Stored as its own table because it is referenced by canvas nodes via
    ``ref_id``, carries the 07 panel and 08 clip paths, and is the target of an
    independent video-generation job.
    """

    __tablename__ = "segment"

    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episode.id"))
    segment_id: Mapped[int]
    duration_sec: Mapped[int]
    spec: Mapped[dict] = mapped_column(JSON, default=dict)  # full Segment schema
    panel_path: Mapped[str | None] = mapped_column(default=None)  # 07 draft panel
    clip_path: Mapped[str | None] = mapped_column(default=None)  # 08 video clip

    episode: Mapped["Episode"] = relationship(back_populates="segments")


class GenerationJob(Base):
    """Async generation task state (docs/03 §4).

    ``provider_task_id`` mirrors the channel-side task id so an interrupted
    local poll loop can be resumed (docs/03 §4.3, cf. test/videogen.py poll).
    """

    __tablename__ = "generation_job"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(12))
    target_table: Mapped[str] = mapped_column(String(40))
    target_id: Mapped[int]
    provider_task_id: Mapped[str | None] = mapped_column(default=None)
    request: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict | None] = mapped_column(JSON, default=None)
    error: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


# Engine + session factory. SQLite needs check_same_thread off for the threaded
# dev server; the URL itself comes from typed settings. ``SessionLocal`` is a
# module-level sessionmaker that callers import by reference; tests rebind it in
# place via ``configure_database`` (no module reload, so enum identities stay
# stable across the process).
def _make_engine(url: str):
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)


engine = _make_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def configure_database(url: str) -> None:
    """Rebind the engine and session factory to ``url`` in place.

    Disposes the previous engine and reconfigures the existing ``SessionLocal``
    so already-imported references keep working. Used by tests to point at an
    isolated database without reloading modules.
    """
    global engine
    engine.dispose()
    engine = _make_engine(url)
    SessionLocal.configure(bind=engine)


def init_db() -> None:
    """Create all tables. Idempotent; safe to call on startup for the slice.

    Replaced by Alembic migrations in a later milestone (docs/05_roadmap.md).
    """
    Base.metadata.create_all(engine)
