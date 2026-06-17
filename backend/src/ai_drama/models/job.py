"""Generation job pydantic schemas — async task state (docs/03 §4)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from ai_drama.models.enums import JobKind, JobStatus


class JobRead(BaseModel):
    """A generation job as returned to clients (frontend polls this)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: JobKind
    status: JobStatus
    target_table: str
    target_id: int
    provider_task_id: str | None
    result: dict | None
    error: str | None
    created_at: datetime
    updated_at: datetime
