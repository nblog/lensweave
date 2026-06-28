"""Canvas-compiler tests (docs/05 §2 test/04_canvas).

Verifies the compute-graph → VideoGenRequest reduction (docs/01 §2.4, ADR-006):
the prompt comes from a TEXT input, the mixed input blocks keep edge order for
provider context submission, IMAGE inputs remain available as ordered reference
images, and malformed graphs raise CompileError.
"""

from __future__ import annotations

import pytest

from ai_drama.models import CanvasEdge, CanvasGraph, CanvasNode, NodeKind
from ai_drama.services.canvas_compiler import (
    CompileError,
    compile_image_request,
    compile_text_request,
    compile_video_request,
)


def _image_for(ref_id):
    return {10: "char.png", 20: "scene.png"}.get(ref_id)


def _graph() -> CanvasGraph:
    return CanvasGraph(
        episode_id=1,
        nodes=[
            CanvasNode(id="c", kind=NodeKind.IMAGE, ref_id=10),
            CanvasNode(id="s", kind=NodeKind.IMAGE, ref_id=20),
            CanvasNode(
                id="txt",
                kind=NodeKind.TEXT,
                data={"visual_prompt": "a quiet courtyard"},
            ),
            CanvasNode(id="vg", kind=NodeKind.VIDEO_GEN),
        ],
        edges=[
            CanvasEdge(id="e1", source="c", target="vg", order=1),
            CanvasEdge(id="e2", source="txt", target="vg", order=2),
            CanvasEdge(id="e3", source="s", target="vg", order=3),
        ],
    )


def test_compile_orders_images_by_edge_order():
    req = compile_video_request(
        _graph(), output_node_id="vg", resolve_asset_image=_image_for
    )
    # Edge order 1 (char) before order 3 (scene); text input carries no image.
    assert [
        item.image.ref for item in req.ordered_content if item.image is not None
    ] == ["char.png", "scene.png"]
    assert req.duration == 15
    assert req.ratio == "9:16"
    assert req.resolution == "720p"


def test_compile_text_request_preserves_all_ordered_text_inputs():
    """TextGen preserves every ordered text input instead of silently dropping later ones."""
    g = CanvasGraph(
        episode_id=1,
        nodes=[
            CanvasNode(
                id="episode",
                kind=NodeKind.TEXT,
                data={"visual_prompt": "episode script"},
            ),
            CanvasNode(
                id="character",
                kind=NodeKind.TEXT,
                data={"visual_prompt": "character card"},
            ),
            CanvasNode(id="tg", kind=NodeKind.TEXT_GEN),
        ],
        edges=[
            CanvasEdge(id="e1", source="episode", target="tg", order=2),
            CanvasEdge(id="e2", source="character", target="tg", order=1),
        ],
    )

    req = compile_text_request(g, output_node_id="tg")

    assert req.input_texts == ["character card", "episode script"]
    assert "prompt" not in req.model_dump()


def test_compile_image_request_uses_current_text_gen_node_text():
    """Downstream adapters consume the current saved text on a text_gen node."""
    g = CanvasGraph(
        episode_id=1,
        nodes=[
            CanvasNode(
                id="tg",
                kind=NodeKind.TEXT_GEN,
                data={"visual_prompt": "edited generated text"},
            ),
            CanvasNode(id="ig", kind=NodeKind.IMAGE_GEN),
        ],
        edges=[CanvasEdge(id="e1", source="tg", target="ig", order=1)],
    )

    req = compile_image_request(
        g, output_node_id="ig", resolve_asset_image=_image_for
    )

    assert "prompt" not in req.model_dump()
    assert "images" not in req.model_dump()
    assert [item.type for item in req.ordered_content] == ["text"]
    assert req.ordered_content[0].text == "edited generated text"


def test_compile_image_request_preserves_mixed_multimodal_input_order():
    """ImageGen keeps image/image/text/text order for agent-framework messages."""
    g = CanvasGraph(
        episode_id=1,
        nodes=[
            CanvasNode(id="c", kind=NodeKind.IMAGE, ref_id=10),
            CanvasNode(id="s", kind=NodeKind.IMAGE, ref_id=20),
            CanvasNode(
                id="scene",
                kind=NodeKind.TEXT,
                data={"visual_prompt": "a quiet courtyard"},
            ),
            CanvasNode(
                id="style",
                kind=NodeKind.TEXT,
                data={"visual_prompt": "cinematic dusk lighting"},
            ),
            CanvasNode(id="ig", kind=NodeKind.IMAGE_GEN),
        ],
        edges=[
            CanvasEdge(id="e1", source="c", target="ig", order=1),
            CanvasEdge(id="e2", source="s", target="ig", order=2),
            CanvasEdge(id="e3", source="scene", target="ig", order=3),
            CanvasEdge(id="e4", source="style", target="ig", order=4),
        ],
    )

    req = compile_image_request(
        g, output_node_id="ig", resolve_asset_image=_image_for
    )

    assert [item.type for item in req.ordered_content] == [
        "image",
        "image",
        "text",
        "text",
    ]
    assert req.ordered_content[0].image.ref == "char.png"
    assert req.ordered_content[1].image.ref == "scene.png"
    assert req.ordered_content[2].text == "a quiet courtyard"
    assert req.ordered_content[3].text == "cinematic dusk lighting"


def test_compile_uses_video_gen_node_settings():
    g = _graph()
    g.nodes[-1].data = {"duration": 12, "ratio": "16:9", "resolution": "1080p"}

    req = compile_video_request(g, output_node_id="vg", resolve_asset_image=_image_for)

    assert req.duration == 12
    assert req.ratio == "16:9"
    assert req.resolution == "1080p"


def test_compile_rejects_video_gen_duration_out_of_range():
    g = _graph()
    g.nodes[-1].data = {"duration": 16}

    with pytest.raises(CompileError, match="between 4 and 15"):
        compile_video_request(g, output_node_id="vg", resolve_asset_image=_image_for)


def test_compile_rejects_video_gen_ratio_out_of_catalog():
    g = _graph()
    g.nodes[-1].data = {"ratio": "4:3"}

    with pytest.raises(CompileError, match="ratio must be one of"):
        compile_video_request(g, output_node_id="vg", resolve_asset_image=_image_for)


def test_compile_preserves_mixed_input_order_for_provider_context():
    req = compile_video_request(
        _graph(), output_node_id="vg", resolve_asset_image=_image_for
    )

    assert "prompt" not in req.model_dump()
    assert "images" not in req.model_dump()
    assert [item.type for item in req.ordered_content] == ["image", "text", "image"]
    assert req.ordered_content[0].image.ref == "char.png"
    assert req.ordered_content[1].text == "a quiet courtyard"
    assert req.ordered_content[2].image.ref == "scene.png"


def test_compile_requires_prompt():
    g = CanvasGraph(
        episode_id=1,
        nodes=[
            CanvasNode(id="c", kind=NodeKind.IMAGE, ref_id=10),
            CanvasNode(id="vg", kind=NodeKind.VIDEO_GEN),
        ],
        edges=[CanvasEdge(id="e1", source="c", target="vg")],
    )
    with pytest.raises(CompileError, match="no text input"):
        compile_video_request(g, output_node_id="vg", resolve_asset_image=_image_for)


def test_compile_rejects_non_video_gen_target():
    with pytest.raises(CompileError, match="not a video_gen"):
        compile_video_request(
            _graph(), output_node_id="txt", resolve_asset_image=_image_for
        )
