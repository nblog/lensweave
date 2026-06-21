"""Pydantic schemas — the over-the-wire shapes shared by API and CLI.

These are deliberately separate from the ORM models in ``db.py``: pydantic owns
the external contract (validation, serialization, OpenAPI), the ORM owns the
on-disk shape, and the service layer converts between them (docs/01 §1).

Submodules are organized by domain area; this package re-exports the names so
callers can ``from ai_drama.models import ProjectCreate`` regardless of layout.
"""

from __future__ import annotations

from ai_drama.models.asset import AssetCreate, AssetRead, AssetUpdate
from ai_drama.models.canvas import CanvasEdge, CanvasGraph, CanvasNode
from ai_drama.models.enums import (
    ADAPTER_INPUT_TYPES,
    ADAPTER_NODE_JOB_KIND,
    NODE_OUTPUT_TYPE,
    AssetKind,
    AssetScope,
    JobKind,
    JobStatus,
    NodeKind,
    PortType,
    is_adapter_node,
)
from ai_drama.models.episode import EpisodeCreate, EpisodeRead
from ai_drama.models.job import JobRead
from ai_drama.models.project import ProjectCreate, ProjectRead, ProjectSensitiveAction
from ai_drama.models.storyboard import (
    DialogueLine,
    Segment,
    SegmentRead,
    StoryboardJSON,
)
from ai_drama.models.user import (
    AuthSession,
    LoginRequest,
    UserCreate,
    UserRead,
    UserUpdate,
)

__all__ = [
    "ADAPTER_INPUT_TYPES",
    "ADAPTER_NODE_JOB_KIND",
    "NODE_OUTPUT_TYPE",
    "AssetCreate",
    "AssetKind",
    "AssetScope",
    "AssetRead",
    "AssetUpdate",
    "AuthSession",
    "CanvasEdge",
    "CanvasGraph",
    "CanvasNode",
    "DialogueLine",
    "EpisodeCreate",
    "EpisodeRead",
    "JobKind",
    "JobRead",
    "JobStatus",
    "LoginRequest",
    "NodeKind",
    "PortType",
    "ProjectCreate",
    "ProjectRead",
    "ProjectSensitiveAction",
    "Segment",
    "SegmentRead",
    "StoryboardJSON",
    "UserCreate",
    "UserRead",
    "UserUpdate",
    "is_adapter_node",
]
