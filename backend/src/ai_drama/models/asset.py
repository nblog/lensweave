"""Asset pydantic schemas — global visual assets (character / prop / scene).

Assets are a top-level, global library (ADR-005): they are created independent
of any project and referenced by projects via a many-to-many association. The
``spec`` field holds the visual-anchor parameters; it tightens into the
CharacterVisualAnchor / SceneSpec schemas (docs/01 §2.2) in a later milestone.
``source_project_id`` records which project's 02 Bible first generated it.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from ai_drama.models.enums import AssetKind


class AssetCreate(BaseModel):
    """Request body for creating a global asset."""

    kind: AssetKind
    name: str = Field(min_length=1, max_length=200)
    spec: dict = Field(default_factory=dict)
    image_path: str | None = None
    source_project_id: int | None = None


class AssetRead(BaseModel):
    """Asset as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: AssetKind
    name: str
    spec: dict
    image_path: str | None
    source_project_id: int | None
    created_at: datetime
