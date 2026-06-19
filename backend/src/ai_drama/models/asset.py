"""Asset pydantic schemas — layered visual assets."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from ai_drama.models.enums import AssetKind, AssetScope


class AssetCreate(BaseModel):
    """Request body for creating an asset in one disclosure layer."""

    kind: AssetKind
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    spec: dict = Field(default_factory=dict)
    image_path: str | None = None
    scope: AssetScope | None = None
    episode_id: int | None = None
    source_asset_id: int | None = None


class AssetUpdate(BaseModel):
    """Partial request body for editing an existing asset."""

    kind: AssetKind | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    spec: dict | None = None
    image_path: str | None = None
    source_asset_id: int | None = None


class AssetRead(BaseModel):
    """Asset as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int | None
    episode_id: int | None = None
    source_asset_id: int | None = None
    scope: AssetScope
    kind: AssetKind
    name: str
    description: str | None
    spec: dict
    image_path: str | None
    created_at: datetime
