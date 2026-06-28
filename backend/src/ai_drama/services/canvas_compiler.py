"""Canvas → adapter-request compiler (docs/01 §2.4, ADR-006).

Turns the free-form compute graph the user edits into the structured input an
adapter consumes. For a chosen adapter node it walks the incoming edges, orders
them by ``CanvasEdge.order``, and compiles TEXT/IMAGE inputs into ordered
request content. IMAGE inputs reference an ImageNode's Asset.image_path or an
upstream image product; character/scene/prop semantics ride on the referenced
project Asset.kind, not on node type.

This is the concrete realization of ADR-001/006's "constraint guardrail": the
frontend lets the user draw freely, and this compiler is where the graph is
safely reduced to something the adapter can run.
"""

from __future__ import annotations

from collections.abc import Callable

from ai_drama.adapters.base import (
    ImageContentItem,
    ImageGenRequest,
    ImageRef,
    MultimodalContentType,
    VideoContentItem,
    TextGenRequest,
    VideoGenRequest,
    VideoImageSlot,
)
from ai_drama.model_catalog import VideoGenSettings, get_seedance_video_settings
from ai_drama.models import CanvasGraph, NodeKind, PortType
from ai_drama.models.enums import NODE_OUTPUT_TYPE, is_adapter_node


class CompileError(ValueError):
    """Raised when a canvas cannot be compiled into a runnable request."""


def _ordered_inputs(graph: CanvasGraph, target_id: str):
    """Yield (node, port_type) of the target's inputs, sorted by edge order."""
    by_id = {n.id: n for n in graph.nodes}
    in_edges = [e for e in graph.edges if e.target == target_id]
    in_edges.sort(key=lambda e: e.order)
    for edge in in_edges:
        src = by_id[edge.source]
        yield src, NODE_OUTPUT_TYPE[src.kind]


def _text_from_node(node) -> str | None:
    data = node.data or {}
    return data.get("visual_prompt") or data.get("text")


def _image_ref_from_node(node, resolve_asset_image: Callable[[int | None], str | None]):
    data = node.data or {}
    for key in ("image_path", "image_url", "image_uri"):
        value = data.get(key)
        if value:
            return value
    if node.kind is NodeKind.IMAGE:
        return resolve_asset_image(node.ref_id)
    return None


def _video_duration_from_node(data: dict, settings: VideoGenSettings) -> int:
    value = data.get("duration")
    if value is None:
        return settings.duration.default
    if isinstance(value, bool):
        raise CompileError("video_gen duration must be an integer")
    if isinstance(value, float) and not value.is_integer():
        raise CompileError("video_gen duration must be an integer")
    try:
        duration = int(value)
    except (TypeError, ValueError) as exc:
        raise CompileError("video_gen duration must be an integer") from exc

    if not settings.duration.min <= duration <= settings.duration.max:
        raise CompileError(
            "video_gen duration must be between "
            f"{settings.duration.min} and {settings.duration.max} seconds"
        )
    return duration


def _video_resolution_from_node(data: dict, settings: VideoGenSettings) -> str:
    value = data.get("resolution") or settings.resolution.default
    if not isinstance(value, str) or value not in settings.resolution.options:
        options = ", ".join(settings.resolution.options)
        raise CompileError(f"video_gen resolution must be one of: {options}")
    return value


def _video_ratio_from_node(data: dict, settings: VideoGenSettings) -> str:
    value = data.get("ratio") or settings.ratio.default
    if not isinstance(value, str) or value not in settings.ratio.options:
        options = ", ".join(settings.ratio.options)
        raise CompileError(f"video_gen ratio must be one of: {options}")
    return value


def compile_text_request(
    graph: CanvasGraph,
    *,
    output_node_id: str,
) -> TextGenRequest:
    """Compile a TEXT_GEN adapter node's ordered text inputs into a request."""
    by_id = {n.id: n for n in graph.nodes}
    node = by_id.get(output_node_id)
    if node is None or node.kind is not NodeKind.TEXT_GEN:
        raise CompileError(f"{output_node_id!r} is not a text_gen node")
    if not is_adapter_node(node.kind):
        raise CompileError(f"{output_node_id!r} is not an adapter node")

    input_texts: list[str] = []
    for src, port in _ordered_inputs(graph, output_node_id):
        if port is PortType.TEXT:
            text = _text_from_node(src)
            if text:
                input_texts.append(text)

    if not input_texts:
        raise CompileError("no text input with a prompt feeds the text_gen node")
    data = node.data or {}
    return TextGenRequest(
        input_texts=input_texts,
        system_prompt=data.get("system_prompt") or "You are a helpful assistant.",
        model=data.get("model"),
        max_tokens=data.get("max_tokens"),
        temperature=data.get("temperature"),
        reasoning_effort=data.get("reasoning_effort", "medium"),
    )


def compile_image_request(
    graph: CanvasGraph,
    *,
    output_node_id: str,
    resolve_asset_image: Callable[[int | None], str | None],
) -> ImageGenRequest:
    """Compile an IMAGE_GEN adapter node's ordered text/images into a request."""
    by_id = {n.id: n for n in graph.nodes}
    node = by_id.get(output_node_id)
    if node is None or node.kind is not NodeKind.IMAGE_GEN:
        raise CompileError(f"{output_node_id!r} is not an image_gen node")
    if not is_adapter_node(node.kind):
        raise CompileError(f"{output_node_id!r} is not an adapter node")

    ordered_content: list[ImageContentItem] = []
    has_text = False
    for src, port in _ordered_inputs(graph, output_node_id):
        if port is PortType.TEXT:
            text = _text_from_node(src)
            if text:
                has_text = True
                ordered_content.append(
                    ImageContentItem(type=MultimodalContentType.TEXT, text=text)
                )
        elif port is PortType.IMAGE:
            image_ref = _image_ref_from_node(src, resolve_asset_image)
            if image_ref:
                image = ImageRef(ref=image_ref)
                ordered_content.append(
                    ImageContentItem(type=MultimodalContentType.IMAGE, image=image)
                )

    if not has_text:
        raise CompileError("no text input with a prompt feeds the image_gen node")

    data = node.data or {}
    return ImageGenRequest(
        ordered_content=ordered_content,
        model=data.get("model"),
        size=data.get("size"),
        quality=data.get("quality"),
        output_format=data.get("output_format"),
        background=data.get("background"),
        moderation=data.get("moderation"),
        output_compression=data.get("output_compression"),
    )


def compile_video_request(
    graph: CanvasGraph,
    *,
    output_node_id: str,
    resolve_asset_image,
    video_settings: VideoGenSettings | None = None,
) -> VideoGenRequest:
    """Compile a VIDEO_GEN adapter node's inputs into a VideoGenRequest.

    ``resolve_asset_image`` maps an ImageNode's ``ref_id`` (an Asset id) to an
    image ref (path/URL); return None for assets without a generated image
    (they are skipped).
    """
    by_id = {n.id: n for n in graph.nodes}
    node = by_id.get(output_node_id)
    if node is None or node.kind is not NodeKind.VIDEO_GEN:
        raise CompileError(f"{output_node_id!r} is not a video_gen node")
    if not is_adapter_node(node.kind):
        raise CompileError(f"{output_node_id!r} is not an adapter node")

    inputs = list(_ordered_inputs(graph, output_node_id))
    if not inputs:
        raise CompileError("video_gen node has no inputs")

    ordered_content: list[VideoContentItem] = []
    has_text = False
    for src, port in inputs:
        if port is PortType.TEXT:
            text = _text_from_node(src)
            if text:
                has_text = True
                ordered_content.append(
                    VideoContentItem(type=MultimodalContentType.TEXT, text=text)
                )
        elif port is PortType.IMAGE:
            image_ref = _image_ref_from_node(src, resolve_asset_image)
            if image_ref:
                image_slot = VideoImageSlot(ref=image_ref)
                ordered_content.append(
                    VideoContentItem(
                        type=MultimodalContentType.IMAGE, image=image_slot
                    )
                )

    if not has_text:
        raise CompileError("no text input with a prompt feeds the video_gen node")

    data = node.data or {}
    settings = video_settings or get_seedance_video_settings()
    return VideoGenRequest(
        ordered_content=ordered_content,
        duration=_video_duration_from_node(data, settings),
        ratio=_video_ratio_from_node(data, settings),
        resolution=_video_resolution_from_node(data, settings),
    )
