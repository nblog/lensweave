"""Schema-constraint tests (docs/05 §2 test/02_models).

Locks the storyboard segment-local invariants and the canvas topology guardrails
that the rest of the system relies on. Episode total duration is intentionally
not part of the current model; segment duration remains a per-fragment default
and cap.
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


def _seg(sid: int, dur: int | None = None) -> Segment:
    kwargs = {"segment_id": sid, "visual_prompt": f"shot {sid}"}
    if dur is not None:
        kwargs["duration_sec"] = dur
    return Segment(**kwargs)


def test_segment_defaults_to_15_seconds():
    seg = Segment(segment_id=1, visual_prompt="default duration")

    assert seg.duration_sec <= 15


def test_storyboard_accepts_segments_without_episode_duration():
    sb = StoryboardJSON(
        episode_id=1,
        title="EP",
        segments=[_seg(1), _seg(2, 10)],
    )

    assert len(sb.segments) == 2


def test_storyboard_rejects_duplicate_segment_ids():
    with pytest.raises(ValidationError, match="duplicate segment_id"):
        StoryboardJSON(
            episode_id=1,
            title="EP",
            segments=[_seg(1), _seg(1)],
        )


def test_segment_duration_cap():
    with pytest.raises(ValidationError):
        Segment(segment_id=1, duration_sec=16, visual_prompt="too long")


def test_canvas_node_position_persists_optional_size():
    node = CanvasNode(
        id="t",
        kind=NodeKind.TEXT,
        position={"x": 10, "y": 20, "width": 320, "height": 180},
    )

    payload = node.model_dump(mode="json")

    assert payload["position"] == {
        "x": 10.0,
        "y": 20.0,
        "width": 320.0,
        "height": 180.0,
    }


def test_canvas_node_position_reads_legacy_coordinate_tuple():
    node = CanvasNode.model_validate(
        {"id": "t", "kind": "text", "position": [10, 20]},
    )

    assert node.position.x == 10
    assert node.position.y == 20
    assert node.position.width is None
    assert node.position.height is None


def test_canvas_node_position_rejects_partial_size():
    with pytest.raises(ValidationError, match="provided together"):
        CanvasNode(
            id="t",
            kind=NodeKind.TEXT,
            position={"x": 0, "y": 0, "width": 320},
        )


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
