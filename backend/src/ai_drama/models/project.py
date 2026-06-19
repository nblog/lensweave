"""Project pydantic schemas — over-the-wire shapes for project resources."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    """Request body for creating a project."""

    title: str = Field(min_length=1, max_length=200)


class ProjectRead(BaseModel):
    """Project as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    uid: str
    title: str
    created_at: datetime
