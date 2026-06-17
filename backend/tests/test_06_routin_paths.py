"""Routin path normalization tests.

Generated image jobs return browser-facing ``/images/...`` URLs for preview,
while routin image/video adapters need readable local files for provider input.
This locks that boundary so a saved canvas can feed an ImageGen output into
VideoGen without treating ``/images/...`` as a filesystem root path.
"""

from __future__ import annotations

import base64

from ai_drama.adapters import routin
from ai_drama.adapters.base import (
    VideoContentItem,
    VideoContentType,
    VideoGenRequest,
    VideoImageSlot,
)

_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB"
    "/6X3yAAAAABJRU5ErkJggg=="
)


def test_static_images_url_maps_to_generated_image_file(tmp_path, monkeypatch):
    monkeypatch.setattr(routin, "GENERATED_IMAGES_DIR", tmp_path)
    image_path = tmp_path / "generated.png"
    image_path.write_bytes(_TINY_PNG)

    data_uri = routin._image_ref_to_url("/images/generated.png")

    assert data_uri.startswith("data:image/png;base64,")


def test_local_backend_images_url_maps_to_generated_image_file(tmp_path, monkeypatch):
    monkeypatch.setattr(routin, "GENERATED_IMAGES_DIR", tmp_path)
    image_path = tmp_path / "generated.png"
    image_path.write_bytes(_TINY_PNG)

    data_uri = routin._image_ref_to_url(
        "http://127.0.0.1:8770/images/generated.png"
    )

    assert data_uri.startswith("data:image/png;base64,")


def test_video_content_uses_compiled_canvas_input_order(tmp_path, monkeypatch):
    monkeypatch.setattr(routin, "GENERATED_IMAGES_DIR", tmp_path)
    image_path = tmp_path / "generated.png"
    image_path.write_bytes(_TINY_PNG)

    req = VideoGenRequest(
        prompt="根据 @图1 生成一段口播视频",
        images=[VideoImageSlot(ref="/images/generated.png")],
        ordered_content=[
            VideoContentItem(
                type=VideoContentType.IMAGE,
                image=VideoImageSlot(ref="/images/generated.png"),
            ),
            VideoContentItem(
                type=VideoContentType.TEXT,
                text="根据 @图1 生成一段口播视频",
            ),
        ],
    )

    content = routin._build_content(req)

    assert [item["type"] for item in content] == ["image_url", "text"]
    assert content[0]["role"] == "reference_image"
    assert content[1]["text"] == "根据 @图1 生成一段口播视频"
