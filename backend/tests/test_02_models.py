"""Schema-constraint tests (docs/05 §2 test/02_models).

Locks the storyboard anti-collapse invariants and the canvas topology guardrails
that the rest of the system relies on. These are the rules most prone to silent
failure (segment collapse, illegal graphs), so they are validated directly at
the pydantic layer.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ai_drama.models import (
    CanvasEdge,
    CanvasGraph,
    CanvasNode,
    NodeKind,
    Segment,
    StoryboardJSON,
)


def _seg(sid: int, dur: int) -> Segment:
    return Segment(segment_id=sid, duration_sec=dur, visual_prompt=f"shot {sid}")


def test_storyboard_accepts_closed_floor():
    # 30s ⇒ floor ceil(30/15)=2; two 15s segments close exactly.
    sb = StoryboardJSON(
        episode_id=1,
        title="EP",
        total_duration_sec=30,
        segments=[_seg(1, 15), _seg(2, 15)],
    )
    assert len(sb.segments) == 2


def test_storyboard_rejects_segment_collapse():
    # 180s collapsed into one segment must fail the floor check.
    with pytest.raises(ValidationError, match="segment collapse"):
        StoryboardJSON(
            episode_id=1,
            title="EP",
            total_duration_sec=180,
            segments=[_seg(1, 15)],
        )


def test_storyboard_rejects_unclosed_total():
    with pytest.raises(ValidationError, match="!= total_duration_sec"):
        StoryboardJSON(
            episode_id=1,
            title="EP",
            total_duration_sec=30,
            segments=[_seg(1, 10), _seg(2, 15)],
        )


def test_segment_duration_cap():
    with pytest.raises(ValidationError):
        Segment(segment_id=1, duration_sec=16, visual_prompt="too long")


def test_canvas_rejects_cycle():
    # Two adapter nodes feeding each other — text_gen accepts text input.
    with pytest.raises(ValidationError, match="acyclic"):
        CanvasGraph(
            episode_id=1,
            nodes=[
                CanvasNode(id="a", kind=NodeKind.TEXT_GEN),
                CanvasNode(id="b", kind=NodeKind.TEXT_GEN),
            ],
            edges=[
                CanvasEdge(id="e1", source="a", target="b"),
                CanvasEdge(id="e2", source="b", target="a"),
            ],
        )


def test_canvas_rejects_input_to_data_node():
    # A data node accepts no input.
    with pytest.raises(ValidationError, match="accepts no input"):
        CanvasGraph(
            episode_id=1,
            nodes=[
                CanvasNode(id="t", kind=NodeKind.TEXT),
                CanvasNode(id="i", kind=NodeKind.IMAGE),
            ],
            edges=[CanvasEdge(id="e", source="t", target="i")],
        )


def test_canvas_rejects_incompatible_port_type():
    # text_gen accepts only text; feeding it an image is incompatible.
    with pytest.raises(ValidationError, match="incompatible"):
        CanvasGraph(
            episode_id=1,
            nodes=[
                CanvasNode(id="img", kind=NodeKind.IMAGE),
                CanvasNode(id="tg", kind=NodeKind.TEXT_GEN),
            ],
            edges=[CanvasEdge(id="e", source="img", target="tg")],
        )


def test_canvas_accepts_image_and_text_into_video_gen():
    # video_gen accepts both text and image inputs.
    g = CanvasGraph(
        episode_id=1,
        nodes=[
            CanvasNode(id="img", kind=NodeKind.IMAGE),
            CanvasNode(id="txt", kind=NodeKind.TEXT),
            CanvasNode(id="vg", kind=NodeKind.VIDEO_GEN),
        ],
        edges=[
            CanvasEdge(id="e1", source="img", target="vg", order=1),
            CanvasEdge(id="e2", source="txt", target="vg", order=2),
        ],
    )
    assert len(g.edges) == 2


def test_canvas_rejects_missing_endpoint():
    with pytest.raises(ValidationError, match="missing node"):
        CanvasGraph(
            episode_id=1,
            nodes=[CanvasNode(id="a", kind=NodeKind.TEXT)],
            edges=[CanvasEdge(id="e", source="a", target="ghost")],
        )
