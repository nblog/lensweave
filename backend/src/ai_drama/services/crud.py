"""Project / Asset / Episode / Canvas / Segment CRUD services.

Transport-agnostic business logic (docs/03 §1): functions take a session plus
typed inputs and return ORM rows or pydantic models, reachable from both the
HTTP API and the CLI. Cross-entity consistency checks live here (e.g. an asset
or canvas must belong to an existing project / episode).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ai_drama.db import Asset, Episode, GenerationJob, Project, Segment
from ai_drama.models import (
    AssetCreate,
    AssetScope,
    AssetUpdate,
    CanvasGraph,
    EpisodeCreate,
    ProjectCreate,
    ProjectSensitiveAction,
    StoryboardJSON,
)
from ai_drama.models.project import DEFAULT_PROJECT_SECONDARY_PASSWORD


# --- project ---

PASSWORD_HASH_ALGORITHM = "pbkdf2_sha256"
PASSWORD_HASH_ITERATIONS = 390_000


def create_project(db: Session, data: ProjectCreate) -> Project:
    project = Project(
        title=data.title,
        secondary_password_hash=_hash_project_secondary_password(
            data.secondary_password
        ),
    )
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


def delete_project(
    db: Session, project_id: int, data: ProjectSensitiveAction
) -> None:
    """Delete one project and its owned rows while leaving global assets intact."""
    project = db.get(Project, project_id)
    if project is None:
        raise LookupError(f"project {project_id} not found")
    if not _verify_project_secondary_password(
        project.secondary_password_hash, data.secondary_password
    ):
        raise PermissionError("secondary password mismatch")

    episode_ids = list(
        db.scalars(select(Episode.id).where(Episode.project_id == project.id))
    )
    segment_ids = (
        list(db.scalars(select(Segment.id).where(Segment.episode_id.in_(episode_ids))))
        if episode_ids
        else []
    )

    db.execute(
        delete(GenerationJob).where(
            GenerationJob.target_table == "project",
            GenerationJob.target_id == project.id,
        )
    )
    if episode_ids:
        db.execute(
            delete(GenerationJob).where(
                GenerationJob.target_table == "episode",
                GenerationJob.target_id.in_(episode_ids),
            )
        )
    if segment_ids:
        db.execute(
            delete(GenerationJob).where(
                GenerationJob.target_table == "segment",
                GenerationJob.target_id.in_(segment_ids),
            )
        )

    db.delete(project)
    db.commit()


def _hash_project_secondary_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        PASSWORD_HASH_ITERATIONS,
    ).hex()
    return (
        f"{PASSWORD_HASH_ALGORITHM}${PASSWORD_HASH_ITERATIONS}${salt}${digest}"
    )


def _verify_project_secondary_password(
    stored_hash: str | None, password: str
) -> bool:
    if stored_hash is None:
        return hmac.compare_digest(password, DEFAULT_PROJECT_SECONDARY_PASSWORD)

    try:
        algorithm, iterations_raw, salt, digest = stored_hash.split("$", 3)
        iterations = int(iterations_raw)
    except ValueError:
        return False

    if algorithm != PASSWORD_HASH_ALGORITHM:
        return False

    candidate = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        iterations,
    ).hex()
    return hmac.compare_digest(candidate, digest)


# --- asset (global / project fixed / episode temporary) ---


def create_global_asset(db: Session, data: AssetCreate) -> Asset:
    """Create an asset in the global library."""
    return _create_asset(db, data, scope=AssetScope.GLOBAL)


def create_project_asset(db: Session, project_id: int, data: AssetCreate) -> Asset:
    """Create an asset at project scope unless the request asks for global."""
    scope = _asset_scope(data, default=AssetScope.FIXED)
    if scope == AssetScope.GLOBAL:
        return create_global_asset(db, data)
    if scope == AssetScope.TEMPORARY:
        if data.episode_id is None:
            raise LookupError("episode_id is required for temporary project assets")
        episode = db.get(Episode, data.episode_id)
        if episode is None or episode.project_id != project_id:
            raise LookupError(
                f"episode {data.episode_id} not found in project {project_id}"
            )
        return _create_asset(db, data, scope=scope, project_id=project_id, episode_id=episode.id)
    return _create_asset(db, data, scope=scope, project_id=project_id)


def create_episode_asset(db: Session, episode_id: int, data: AssetCreate) -> Asset:
    """Create an asset from an episode context.

    The default is a temporary asset scoped to that episode, but the same
    endpoint can intentionally disclose the asset as project-fixed or global.
    """
    episode = db.get(Episode, episode_id)
    if episode is None:
        raise LookupError(f"episode {episode_id} not found")
    scope = _asset_scope(data, default=AssetScope.TEMPORARY)
    if scope == AssetScope.GLOBAL:
        return create_global_asset(db, data)
    if scope == AssetScope.FIXED:
        return _create_asset(db, data, scope=scope, project_id=episode.project_id)
    return _create_asset(
        db,
        data,
        scope=scope,
        project_id=episode.project_id,
        episode_id=episode.id,
    )


def _create_asset(
    db: Session,
    data: AssetCreate,
    *,
    scope: AssetScope,
    project_id: int | None = None,
    episode_id: int | None = None,
) -> Asset:
    if project_id is not None and db.get(Project, project_id) is None:
        raise LookupError(f"project {project_id} not found")
    if episode_id is not None:
        episode = db.get(Episode, episode_id)
        if episode is None:
            raise LookupError(f"episode {episode_id} not found")
        if project_id is not None and episode.project_id != project_id:
            raise LookupError(f"episode {episode_id} not found in project {project_id}")
    source = _source_asset(db, data.source_asset_id)
    spec = dict(data.spec)
    spec["asset_scope"] = scope.value
    if source is not None:
        spec["source_asset_id"] = source.id
    asset = Asset(
        project_id=project_id,
        episode_id=episode_id,
        source_asset_id=source.id if source else None,
        kind=data.kind.value,
        name=data.name,
        description=data.description,
        spec=spec,
        image_path=data.image_path if data.image_path is not None else source.image_path if source else None,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


def list_project_assets(
    db: Session, project_id: int, *, kind: str | None = None
) -> list[Asset]:
    """List assets visible at project level: global + this project's fixed assets."""
    if db.get(Project, project_id) is None:
        raise LookupError(f"project {project_id} not found")
    return _filter_kind(
        [
            *list_global_assets(db, kind=kind),
            *_list_fixed_project_assets(db, project_id, kind=kind),
        ],
        kind,
    )


def list_episode_assets(
    db: Session, episode_id: int, *, kind: str | None = None
) -> list[Asset]:
    """List assets visible in one episode's workshop."""
    episode = db.get(Episode, episode_id)
    if episode is None:
        raise LookupError(f"episode {episode_id} not found")
    return _filter_kind(
        [
            *list_global_assets(db, kind=kind),
            *_list_fixed_project_assets(db, episode.project_id, kind=kind),
            *_list_temporary_episode_assets(db, episode.id, kind=kind),
        ],
        kind,
    )


def list_global_assets(db: Session, *, kind: str | None = None) -> list[Asset]:
    """List global assets that can be referenced from any project or episode."""
    stmt = (
        select(Asset)
        .where(Asset.project_id.is_(None), Asset.episode_id.is_(None))
        .order_by(Asset.id)
    )
    if kind is not None:
        stmt = stmt.where(Asset.kind == kind)
    return list(db.scalars(stmt))


def get_global_asset(db: Session, asset_id: int) -> Asset | None:
    stmt = select(Asset).where(
        Asset.id == asset_id,
        Asset.project_id.is_(None),
        Asset.episode_id.is_(None),
    )
    return db.scalar(stmt)


def get_project_asset(db: Session, project_id: int, asset_id: int) -> Asset | None:
    """Return a project-visible asset: global or this project's fixed asset."""
    asset = db.get(Asset, asset_id)
    if asset is None:
        return None
    if asset.project_id is None and asset.episode_id is None:
        return asset
    if asset.project_id == project_id and asset.episode_id is None:
        return asset
    return None


def get_episode_asset(db: Session, episode_id: int, asset_id: int) -> Asset | None:
    """Return an asset if it is visible in the given episode."""
    episode = db.get(Episode, episode_id)
    if episode is None:
        return None
    asset = db.get(Asset, asset_id)
    if asset is None:
        return None
    if asset.project_id is None and asset.episode_id is None:
        return asset
    if asset.project_id == episode.project_id and asset.episode_id is None:
        return asset
    if asset.project_id == episode.project_id and asset.episode_id == episode.id:
        return asset
    return None


def update_global_asset(db: Session, asset_id: int, data: AssetUpdate) -> Asset:
    asset = get_global_asset(db, asset_id)
    if asset is None:
        raise LookupError(f"global asset {asset_id} not found")
    return _update_asset(db, asset, data)


def update_project_asset(
    db: Session, project_id: int, asset_id: int, data: AssetUpdate
) -> Asset:
    """Edit a fixed asset only when it belongs to the given project."""
    asset = _get_owned_project_asset(db, project_id, asset_id)
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in project {project_id}")
    return _update_asset(db, asset, data)


def update_episode_asset(
    db: Session, episode_id: int, asset_id: int, data: AssetUpdate
) -> Asset:
    """Edit a temporary asset only when it belongs to the given episode."""
    asset = _get_owned_episode_asset(db, episode_id, asset_id)
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in episode {episode_id}")
    return _update_asset(db, asset, data)


def delete_project_asset(db: Session, project_id: int, asset_id: int) -> None:
    """Delete a fixed asset only when it belongs to the given project."""
    asset = _get_owned_project_asset(db, project_id, asset_id)
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in project {project_id}")
    db.delete(asset)
    db.commit()


def delete_episode_asset(db: Session, episode_id: int, asset_id: int) -> None:
    """Delete a temporary asset only when it belongs to the given episode."""
    asset = _get_owned_episode_asset(db, episode_id, asset_id)
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in episode {episode_id}")
    db.delete(asset)
    db.commit()


def delete_global_asset(db: Session, asset_id: int) -> None:
    asset = get_global_asset(db, asset_id)
    if asset is None:
        raise LookupError(f"global asset {asset_id} not found")
    db.delete(asset)
    db.commit()


def _update_asset(db: Session, asset: Asset, data: AssetUpdate) -> Asset:
    fields = data.model_fields_set

    if "kind" in fields and data.kind is not None:
        asset.kind = data.kind.value
    if "name" in fields and data.name is not None:
        asset.name = data.name
    if "description" in fields:
        asset.description = data.description
    if "source_asset_id" in fields:
        source = _source_asset(db, data.source_asset_id)
        asset.source_asset_id = source.id if source else None
        if "image_path" not in fields and source is not None and asset.image_path is None:
            asset.image_path = source.image_path
    if "image_path" in fields:
        asset.image_path = data.image_path

    spec = dict(asset.spec or {})
    if "spec" in fields and data.spec is not None:
        spec.update(data.spec)
    spec["asset_scope"] = asset.scope
    if asset.source_asset_id is None:
        spec.pop("source_asset_id", None)
    else:
        spec["source_asset_id"] = asset.source_asset_id
    asset.spec = spec

    db.commit()
    db.refresh(asset)
    return asset


def _asset_scope(data: AssetCreate, *, default: AssetScope) -> AssetScope:
    if data.scope is not None:
        return data.scope
    raw = data.spec.get("asset_scope")
    if isinstance(raw, str):
        try:
            return AssetScope(raw)
        except ValueError:
            pass
    return default


def _source_asset(db: Session, source_asset_id: int | None) -> Asset | None:
    if source_asset_id is None:
        return None
    source = db.get(Asset, source_asset_id)
    if source is None:
        raise LookupError(f"source asset {source_asset_id} not found")
    return source


def _list_fixed_project_assets(
    db: Session, project_id: int, *, kind: str | None = None
) -> list[Asset]:
    stmt = (
        select(Asset)
        .where(Asset.project_id == project_id, Asset.episode_id.is_(None))
        .order_by(Asset.id)
    )
    if kind is not None:
        stmt = stmt.where(Asset.kind == kind)
    return list(db.scalars(stmt))


def _list_temporary_episode_assets(
    db: Session, episode_id: int, *, kind: str | None = None
) -> list[Asset]:
    stmt = select(Asset).where(Asset.episode_id == episode_id).order_by(Asset.id)
    if kind is not None:
        stmt = stmt.where(Asset.kind == kind)
    return list(db.scalars(stmt))


def _get_owned_project_asset(
    db: Session, project_id: int, asset_id: int
) -> Asset | None:
    stmt = select(Asset).where(
        Asset.id == asset_id,
        Asset.project_id == project_id,
        Asset.episode_id.is_(None),
    )
    return db.scalar(stmt)


def _get_owned_episode_asset(
    db: Session, episode_id: int, asset_id: int
) -> Asset | None:
    episode = db.get(Episode, episode_id)
    if episode is None:
        return None
    stmt = select(Asset).where(
        Asset.id == asset_id,
        Asset.project_id == episode.project_id,
        Asset.episode_id == episode.id,
    )
    return db.scalar(stmt)


def _filter_kind(assets: list[Asset], kind: str | None) -> list[Asset]:
    if kind is None:
        return assets
    return [asset for asset in assets if asset.kind == kind]


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
