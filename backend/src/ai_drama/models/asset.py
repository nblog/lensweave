"""Asset pydantic schemas — project-owned visual assets."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from ai_drama.models.enums import AssetKind


class AssetCreate(BaseModel):
    """Request body for creating an asset inside a project."""

    kind: AssetKind
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    spec: dict = Field(default_factory=dict)
    image_path: str | None = None


class AssetRead(BaseModel):
    """Asset as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    kind: AssetKind
    name: str
    description: str | None
    spec: dict
    image_path: str | None
    created_at: datetime
