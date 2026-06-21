"""Project pydantic schemas — over-the-wire shapes for project resources."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

DEFAULT_PROJECT_SECONDARY_PASSWORD = "123456"


class ProjectCreate(BaseModel):
    """Request body for creating a project."""

    title: str = Field(min_length=1, max_length=200)
    secondary_password: str = Field(
        default=DEFAULT_PROJECT_SECONDARY_PASSWORD,
        min_length=4,
        max_length=128,
    )


class ProjectSensitiveAction(BaseModel):
    """Password confirmation for project-level sensitive operations."""

    secondary_password: str = Field(min_length=1, max_length=128)


class ProjectRead(BaseModel):
    """Project as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    uid: str
    title: str
    created_at: datetime
