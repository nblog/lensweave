"""Canvas → adapter-request compiler (docs/01 §2.4, ADR-006).

Turns the free-form compute graph the user edits into the structured input an
adapter consumes. For a chosen adapter node it walks the incoming edges, orders
them by ``CanvasEdge.order``, and splits inputs by port type: TEXT inputs supply
the prompt, IMAGE inputs supply ordered reference images (from an ImageNode's
referenced Asset.image_path, or an upstream image product). The ordered images
follow the 08 fixed reference order; character/scene/prop semantics ride on the
referenced Asset.kind, not on node type.

This is the concrete realization of ADR-001/006's "constraint guardrail": the
frontend lets the user draw freely, and this compiler is where the graph is
safely reduced to something the adapter can run.
"""

from __future__ import annotations

from collections.abc import Callable

from ai_drama.adapters.base import (
    ImageGenRequest,
    ImageRef,
    VideoContentItem,
    VideoContentType,
    TextGenRequest,
    VideoGenRequest,
    VideoImageSlot,
)
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


def compile_text_request(
    graph: CanvasGraph,
    *,
    output_node_id: str,
) -> TextGenRequest:
    """Compile a TEXT_GEN adapter node's first text input into a request."""
    by_id = {n.id: n for n in graph.nodes}
    node = by_id.get(output_node_id)
    if node is None or node.kind is not NodeKind.TEXT_GEN:
        raise CompileError(f"{output_node_id!r} is not a text_gen node")
    if not is_adapter_node(node.kind):
        raise CompileError(f"{output_node_id!r} is not an adapter node")

    prompt: str | None = None
    for src, port in _ordered_inputs(graph, output_node_id):
        if port is PortType.TEXT:
            prompt = _text_from_node(src)
            if prompt:
                break

    if not prompt:
        raise CompileError("no text input with a prompt feeds the text_gen node")
    data = node.data or {}
    return TextGenRequest(
        prompt=prompt,
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

    prompt: str | None = None
    images: list[ImageRef] = []
    for src, port in _ordered_inputs(graph, output_node_id):
        if port is PortType.TEXT and prompt is None:
            prompt = _text_from_node(src)
        elif port is PortType.IMAGE:
            image_ref = _image_ref_from_node(src, resolve_asset_image)
            if image_ref:
                images.append(ImageRef(ref=image_ref))

    if not prompt:
        raise CompileError("no text input with a prompt feeds the image_gen node")

    data = node.data or {}
    return ImageGenRequest(
        prompt=prompt,
        images=images,
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
    duration: int | None = None,
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

    prompt: str | None = None
    images: list[VideoImageSlot] = []
    ordered_content: list[VideoContentItem] = []
    for src, port in inputs:
        if port is PortType.TEXT:
            text = _text_from_node(src)
            if text:
                if prompt is None:
                    prompt = text
                ordered_content.append(
                    VideoContentItem(type=VideoContentType.TEXT, text=text)
                )
        elif port is PortType.IMAGE:
            image_ref = _image_ref_from_node(src, resolve_asset_image)
            if image_ref:
                image_slot = VideoImageSlot(ref=image_ref)
                images.append(image_slot)
                ordered_content.append(
                    VideoContentItem(type=VideoContentType.IMAGE, image=image_slot)
                )

    if not prompt:
        raise CompileError("no text input with a prompt feeds the video_gen node")

    return VideoGenRequest(
        prompt=prompt,
        images=images,
        ordered_content=ordered_content,
        duration=duration,
    )
