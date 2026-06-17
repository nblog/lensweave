"""Segment & storyboard pydantic schemas — the structured shot language.

This is the strictest contract in the system (docs/01 §2.2, sourced from
test/instructions/06). A ``Segment`` is the 15-second shot fragment that is the
pipeline's minimal unit; ``StoryboardJSON`` is the per-episode collection whose
validators enforce the two rules most prone to failure: the anti-collapse
segment-count floor and total-duration closure.

The rich anchor fields (spatial_anchor / screen_anchor / transition) are modeled
as optional free-form dicts at this slice so a hand-authored demo segment needs
only ``visual_prompt`` + ``duration_sec``. They tighten into dedicated submodels
(docs/01 §2.2) when the 06/07 agents come online.
"""

from __future__ import annotations

import math

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ai_drama.models.enums import JobStatus  # noqa: F401  (re-exported convenience)


class DialogueLine(BaseModel):
    """A single spoken line within a segment."""

    character: str
    text: str
    tone: str = ""


class Segment(BaseModel):
    """A ≤15s shot fragment (test/instructions/06 §2)."""

    segment_id: int
    duration_sec: int = Field(gt=0, le=15)  # §0.1 hard cap
    visual_prompt: str
    scene_name: str = ""
    shot_type: str = ""
    camera_movement: str = ""
    dialogue: list[DialogueLine] = Field(default_factory=list)
    sfx: list[str] = Field(default_factory=list)
    lip_sync: bool = True
    # Optional rich anchors (kept as dicts until the 06/07 agents land).
    spatial_anchor: dict | None = None
    screen_anchor: dict | None = None
    transition_from_prev: dict | None = None


class StoryboardJSON(BaseModel):
    """Per-episode storyboard. Enforces the anti-collapse invariants."""

    episode_id: int
    title: str
    total_duration_sec: int = Field(gt=0)
    segments: list[Segment]

    @model_validator(mode="after")
    def _check_invariants(self) -> "StoryboardJSON":
        # §0.2 anti-collapse: segment-count floor = ceil(total / 15).
        floor = math.ceil(self.total_duration_sec / 15)
        if len(self.segments) < floor:
            raise ValueError(
                f"segment count {len(self.segments)} < floor {floor} "
                f"(ceil({self.total_duration_sec}/15)); likely segment collapse"
            )
        # §0.3 total-duration closure.
        total = sum(s.duration_sec for s in self.segments)
        if total != self.total_duration_sec:
            raise ValueError(
                f"sum(duration_sec)={total} != total_duration_sec="
                f"{self.total_duration_sec}"
            )
        # Segment ids must be unique within the episode.
        ids = [s.segment_id for s in self.segments]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate segment_id within storyboard")
        return self


class SegmentRead(BaseModel):
    """A persisted segment as returned to clients."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    episode_id: int
    segment_id: int
    duration_sec: int
    spec: dict
    panel_path: str | None
    clip_path: str | None
