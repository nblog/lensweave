"""Segment & storyboard pydantic schemas — the structured shot language.

A ``Segment`` is the future 15-second-ish video fragment inside an episode. The
current slice keeps that concept because the 06/08 pipeline will eventually
generate and render many segments per episode, but an ``Episode`` no longer owns
a fixed total duration. ``StoryboardJSON`` therefore validates local storyboard
shape only, not episode-duration closure.

The rich anchor fields (spatial_anchor / screen_anchor / transition) are modeled
as optional free-form dicts at this slice. They tighten into dedicated submodels
(docs/01 §2.2) when the 06/07 agents come online.
"""

from __future__ import annotations

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
    duration_sec: int = Field(default=15, gt=0, le=15)  # §0.1 hard cap
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
    """Per-episode storyboard. Keeps segment identity stable within the episode."""

    episode_id: int
    title: str
    segments: list[Segment]

    @model_validator(mode="after")
    def _check_invariants(self) -> "StoryboardJSON":
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
