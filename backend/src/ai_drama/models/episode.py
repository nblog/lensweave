"""Episode pydantic schemas."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class EpisodeCreate(BaseModel):
    """Request body for creating an episode."""

    episode_no: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=200)
    total_duration_sec: int = Field(gt=0, default=180)


class EpisodeRead(BaseModel):
    """Episode as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    episode_no: int
    title: str
    total_duration_sec: int
