"""SQLAlchemy ORM layer: declarative base, engine/session, and persistence models.

Implements the data model of docs/01 §3 for the current vertical slice:
Project → Asset / Episode → Segment, plus the standalone GenerationJob table.
Whole-document stage outputs (storyboard, canvas, asset spec) are stored as JSON
columns per docs/01 §3.1; Segment is its own table because it is referenced by
canvas nodes, carries panel/clip paths, and runs its own generation job.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    String,
    create_engine,
    func,
    inspect,
    text,
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


def generate_project_uid() -> str:
    """Generate a stable public project identifier for URLs/API paths."""
    return uuid4().hex


class Project(Base):
    """A single drama production. Owns episodes and its private assets."""

    __tablename__ = "project"

    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[str] = mapped_column(
        String(32), unique=True, index=True, default=generate_project_uid
    )
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    story_digest: Mapped[dict | None] = mapped_column(JSON, default=None)
    character_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    world_bible: Mapped[dict | None] = mapped_column(JSON, default=None)
    episode_map: Mapped[dict | None] = mapped_column(JSON, default=None)

    assets: Mapped[list["Asset"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    episodes: Mapped[list["Episode"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Asset(Base):
    """A project-owned visual asset (character / prop / scene); 04/05 output."""

    __tablename__ = "asset"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("project.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(default=None)
    spec: Mapped[dict] = mapped_column(JSON, default=dict)
    image_path: Mapped[str | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    project: Mapped["Project"] = relationship(back_populates="assets")


class Episode(Base):
    """An episode. Owns its segments, storyboard JSON, and canvas graph."""

    __tablename__ = "episode"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("project.id"))
    episode_no: Mapped[int]
    title: Mapped[str] = mapped_column(String(200))
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
    _ensure_project_uid_column()
    _ensure_asset_project_column()


def _ensure_project_uid_column() -> None:
    """Backfill the public project UID column for pre-UID SQLite databases."""
    inspector = inspect(engine)
    if not inspector.has_table("project"):
        return

    column_names = {col["name"] for col in inspector.get_columns("project")}
    with engine.begin() as conn:
        if "uid" not in column_names:
            conn.execute(text("ALTER TABLE project ADD COLUMN uid VARCHAR(32)"))

        rows = conn.execute(
            text("SELECT id FROM project WHERE uid IS NULL OR uid = ''")
        ).fetchall()
        for row in rows:
            conn.execute(
                text("UPDATE project SET uid = :uid WHERE id = :id"),
                {"uid": generate_project_uid(), "id": row.id},
            )

        conn.execute(
            text("CREATE UNIQUE INDEX IF NOT EXISTS ix_project_uid ON project (uid)")
        )


def _ensure_asset_project_column() -> None:
    """Migrate pre-project-owned SQLite assets to the current ownership model."""
    inspector = inspect(engine)
    if not inspector.has_table("asset"):
        return

    asset_columns = {col["name"] for col in inspector.get_columns("asset")}
    had_project_id = "project_id" in asset_columns

    with engine.begin() as conn:
        if not had_project_id:
            conn.execute(text("ALTER TABLE asset ADD COLUMN project_id INTEGER"))

            if "source_project_id" in asset_columns:
                conn.execute(
                    text(
                        """
                        UPDATE asset
                        SET project_id = source_project_id
                        WHERE project_id IS NULL
                          AND source_project_id IS NOT NULL
                          AND EXISTS (
                            SELECT 1 FROM project
                            WHERE project.id = asset.source_project_id
                          )
                        """
                    )
                )

            if inspector.has_table("project_asset"):
                # Old global assets could be referenced by multiple projects.
                # Keep the original row for one project and clone it for the
                # additional references so each project now owns an independent
                # asset row.
                links = conn.execute(
                    text(
                        """
                        SELECT pa.project_id, pa.asset_id
                        FROM project_asset pa
                        JOIN project p ON p.id = pa.project_id
                        JOIN asset a ON a.id = pa.asset_id
                        ORDER BY pa.asset_id, pa.project_id
                        """
                    )
                ).mappings()

                for link in links:
                    row = (
                        conn.execute(
                            text(
                                """
                            SELECT id, kind, name, description, spec, image_path,
                                   created_at, project_id
                            FROM asset
                            WHERE id = :asset_id
                            """
                            ),
                            {"asset_id": link["asset_id"]},
                        )
                        .mappings()
                        .first()
                    )
                    if row is None:
                        continue
                    if row["project_id"] is None:
                        conn.execute(
                            text(
                                "UPDATE asset SET project_id = :project_id "
                                "WHERE id = :asset_id"
                            ),
                            {
                                "project_id": link["project_id"],
                                "asset_id": link["asset_id"],
                            },
                        )
                    elif row["project_id"] != link["project_id"]:
                        conn.execute(
                            text(
                                """
                                INSERT INTO asset (
                                  project_id, kind, name, description, spec,
                                  image_path, created_at
                                )
                                VALUES (
                                  :project_id, :kind, :name, :description, :spec,
                                  :image_path, :created_at
                                )
                                """
                            ),
                            {
                                "project_id": link["project_id"],
                                "kind": row["kind"],
                                "name": row["name"],
                                "description": row["description"],
                                "spec": row["spec"],
                                "image_path": row["image_path"],
                                "created_at": row["created_at"],
                            },
                        )

        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_asset_project_id ON asset (project_id)")
        )
