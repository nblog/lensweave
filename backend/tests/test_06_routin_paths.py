"""Routin path normalization tests.

Generated image jobs return browser-facing ``/images/...`` URLs for preview,
while routin image/video adapters need readable local files for provider input.
This locks that boundary so a saved canvas can feed an ImageGen output into
VideoGen without treating ``/images/...`` as a filesystem root path.
"""

from __future__ import annotations

import base64
import sys
from types import ModuleType, SimpleNamespace

import pytest

from ai_drama.adapters import routin
from ai_drama.adapters.base import (
    TextGenRequest,
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


@pytest.mark.asyncio
async def test_routin_text_adapter_sends_ordered_inputs_as_user_msg_list(monkeypatch):
    captured: dict[str, object] = {}

    class FakeAgent:
        def __init__(self, **_kwargs):
            pass

        async def reply_stream(self, messages):
            captured["messages"] = messages
            yield SimpleNamespace(type="text_delta", delta="ok")

    class FakeCredential:
        def __init__(self, **_kwargs):
            pass

    class FakeUserMsg:
        def __init__(self, name: str, content: str):
            self.name = name
            self.content = content

    class FakeOpenAIChatModel:
        class Parameters:
            def __init__(self, **_kwargs):
                pass

        def __init__(self, **_kwargs):
            pass

    pkg = ModuleType("agentscope")
    pkg.__path__ = []
    agent_mod = ModuleType("agentscope.agent")
    credential_mod = ModuleType("agentscope.credential")
    event_mod = ModuleType("agentscope.event")
    message_mod = ModuleType("agentscope.message")
    model_mod = ModuleType("agentscope.model")
    agent_mod.Agent = FakeAgent
    credential_mod.OpenAICredential = FakeCredential
    event_mod.EventType = SimpleNamespace(TEXT_BLOCK_DELTA="text_delta")
    message_mod.UserMsg = FakeUserMsg
    model_mod.OpenAIChatModel = FakeOpenAIChatModel

    monkeypatch.setitem(sys.modules, "agentscope", pkg)
    monkeypatch.setitem(sys.modules, "agentscope.agent", agent_mod)
    monkeypatch.setitem(sys.modules, "agentscope.credential", credential_mod)
    monkeypatch.setitem(sys.modules, "agentscope.event", event_mod)
    monkeypatch.setitem(sys.modules, "agentscope.message", message_mod)
    monkeypatch.setitem(sys.modules, "agentscope.model", model_mod)

    adapter = routin.RoutinTextAdapter.__new__(routin.RoutinTextAdapter)
    adapter._api_key = "test-key"
    adapter._base_url = "https://example.test/v1"
    adapter._default_model = "test-model"

    result = await adapter.generate(
        TextGenRequest(
            input_texts=["episode script", "character card"],
        )
    )

    messages = captured["messages"]
    assert result.text == "ok"
    assert isinstance(messages, list)
    assert [message.content for message in messages] == [
        "episode script",
        "character card",
    ]
    assert all(isinstance(message, FakeUserMsg) for message in messages)
