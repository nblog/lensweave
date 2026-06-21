"""Routin adapters — wraps the three verified PoC SDK paths.

Text follows ``test/textgen.py`` (AgentScope OpenAIChatModel). Image follows
``test/imagegen2.py`` (agent-framework OpenAIChatClient + image_generation
tool). Video follows ``test/videogen.py`` (Volcengine Ark Runtime tasks).
Endpoint, key, and default model come from typed settings, never hardcoded.

The Ark SDK is synchronous; calls are offloaded to a thread so the adapter
honors the async contract without blocking the event loop.
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
from pathlib import Path
from typing import Iterable, Iterator
from urllib.parse import unquote, urlparse

from ai_drama.adapters.base import (
    ImageAdapter,
    ImageGenRequest,
    ImageGenResult,
    TextAdapter,
    VideoContentType,
    TextGenRequest,
    TextGenResult,
    VideoAdapter,
    VideoGenRequest,
    VideoPollResult,
    VideoSubmitResult,
)
from ai_drama.config import GENERATED_IMAGES_DIR, get_settings

_TERMINAL = {"succeeded", "failed", "canceled"}
_LOCAL_STATIC_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _static_image_path(ref: str) -> Path | None:
    """Map the backend's public ``/images/...`` URL back to its stored file."""
    parsed = urlparse(ref)
    if parsed.scheme and parsed.hostname not in _LOCAL_STATIC_HOSTS:
        return None
    image_path = unquote(parsed.path)
    if not image_path.startswith("/images/"):
        return None
    return GENERATED_IMAGES_DIR / Path(image_path).name


def _local_image_path(ref: str) -> Path:
    path = _static_image_path(ref) or Path(ref)
    if not path.is_file():
        raise FileNotFoundError(f"reference image not found: {ref}")
    return path


def _image_ref_to_url(ref: str) -> str:
    """Pass through remote/data URLs; inline local/static image refs as data URIs."""
    if ref.startswith("data:"):
        return ref
    if _static_image_path(ref) is None and ref.startswith(("http://", "https://")):
        return ref
    path = _local_image_path(ref)
    media_type, _ = mimetypes.guess_type(path.name)
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{media_type or 'image/jpeg'};base64,{b64}"


def _build_content(req: VideoGenRequest) -> list[dict]:
    """Build the Ark content array in the compiled canvas input order.

    Each image carries a ``role`` (Ark rejects image content without it, even
    though the public doc marks it optional — see test/videogen.py)."""
    content: list[dict] = []
    if req.ordered_content:
        for item in req.ordered_content:
            if item.type == VideoContentType.TEXT:
                content.append({"type": "text", "text": item.text})
            elif item.image is not None:
                content.append(
                    {
                        "type": "image_url",
                        "role": item.image.kind.value,
                        "image_url": {"url": _image_ref_to_url(item.image.ref)},
                    }
                )
        return content

    content.append({"type": "text", "text": req.prompt})
    for slot in req.images:
        content.append(
            {
                "type": "image_url",
                "role": slot.kind.value,
                "image_url": {"url": _image_ref_to_url(slot.ref)},
            }
        )
    return content


def _guess_image_media_type(ref: str) -> str:
    """Best-effort image media type for a local path, URL, or data URI."""
    if ref.startswith("data:"):
        header = ref[len("data:") :].split(",", 1)[0]
        media_type = header.split(";", 1)[0].strip()
        return media_type or "image/png"
    guessed, _ = mimetypes.guess_type(ref.split("?", 1)[0])
    return guessed or "image/png"


def _extension_for(media_type: str | None, output_format: str | None) -> str:
    """Pick a file extension from the image media type, falling back to format."""
    if media_type and "/" in media_type:
        return media_type.split("/")[-1]
    if output_format == "jpeg":
        return "jpg"
    return output_format or "webp"


def _save_data_uri(data_uri: str, path: Path) -> int:
    """Decode a ``data:image/...;base64,`` URI to ``path``."""
    if not data_uri.startswith("data:image/") or "," not in data_uri:
        raise ValueError("image output is not a base64 image data URI")
    image_bytes = base64.b64decode(data_uri.split(",", 1)[1])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(image_bytes)
    return len(image_bytes)


def _iter_image_outputs(contents: Iterable[object]) -> Iterator[object]:
    """Yield final/partial image outputs from image_generation tool results."""
    for content in contents:
        if getattr(content, "type", None) != "image_generation_tool_result":
            continue
        outputs = getattr(content, "outputs", None)
        if outputs is None:
            continue
        if isinstance(outputs, list):
            yield from outputs
        else:
            yield outputs


def _require_api_key() -> str:
    settings = get_settings()
    if not settings.routin_api_key:
        raise RuntimeError(
            "ROUTIN_API_KEY is not set; configure backend/.env "
            "(or use the 'mock' channel for offline runs)."
        )
    return settings.routin_api_key


class RoutinTextAdapter(TextAdapter):
    """OpenAI-compatible text generation via AgentScope, matching textgen.py."""

    def __init__(self) -> None:
        settings = get_settings()
        self._api_key = _require_api_key()
        self._base_url = settings.routin_text_base_url
        self._default_model = settings.routin_text_model

    async def generate(self, req: TextGenRequest) -> TextGenResult:
        from agentscope.agent import Agent
        from agentscope.credential import OpenAICredential
        from agentscope.event import EventType
        from agentscope.message import UserMsg
        from agentscope.model import OpenAIChatModel

        parameters = OpenAIChatModel.Parameters(
            max_tokens=req.max_tokens,
            temperature=req.temperature,
            thinking_enable=req.reasoning_effort is not None,
            reasoning_effort=req.reasoning_effort,
        )
        model = req.model or self._default_model
        model_client = OpenAIChatModel(
            credential=OpenAICredential(
                api_key=self._api_key,
                base_url=self._base_url,
            ),
            model=model,
            parameters=parameters,
            stream=True,
            max_retries=3,
            retry_delay=1.0,
            context_size=1_000_000,
            client_kwargs={"timeout": 300.0},
        )
        agent = Agent(
            name="TextGenAgent",
            system_prompt=req.system_prompt,
            model=model_client,
        )

        parts: list[str] = []
        messages = [UserMsg("user", text) for text in req.input_texts]
        async for event in agent.reply_stream(messages):
            if event.type == EventType.TEXT_BLOCK_DELTA:
                delta = getattr(event, "delta", "")
                if delta:
                    parts.append(delta)

        output = "".join(parts)
        if not output:
            raise RuntimeError("no text content found in the model response")
        return TextGenResult(text=output, model=model)


class RoutinImageAdapter(ImageAdapter):
    """OpenAI-compatible image generation via agent-framework, matching imagegen2.py."""

    def __init__(self) -> None:
        settings = get_settings()
        self._api_key = _require_api_key()
        self._base_url = settings.routin_image_base_url
        self._default_model = settings.routin_image_model

    async def generate(self, req: ImageGenRequest, *, out: Path) -> ImageGenResult:
        from agent_framework import Agent, Content, Message
        from agent_framework.openai import OpenAIChatClient
        from openai import AsyncOpenAI

        def image_ref_to_content(ref: str):
            if ref.startswith("data:") or (
                _static_image_path(ref) is None
                and ref.startswith(("http://", "https://"))
            ):
                return Content.from_uri(
                    uri=ref, media_type=_guess_image_media_type(ref)
                )
            path = _local_image_path(ref)
            media_type, _ = mimetypes.guess_type(path.name)
            return Content.from_data(
                data=path.read_bytes(),
                media_type=media_type or "image/png",
            )

        async_client = AsyncOpenAI(
            api_key=self._api_key,
            base_url=self._base_url,
            timeout=900.0,
            max_retries=3,
        )
        model = req.model or self._default_model
        client = OpenAIChatClient(model=model, async_client=async_client)
        image_tool = client.get_image_generation_tool(
            size=req.size,
            output_format=req.output_format,
            quality=req.quality,
            background=req.background,
            partial_images=3,
            moderation=req.moderation,
            output_compression=req.output_compression,
        )
        agent = Agent(
            client=client,
            instructions="You are a helpful agent that can generate images.",
            tools=[image_tool],
            default_options={"tool_choice": "required"},
        )

        contents = [Content.from_text(text=req.prompt)]
        for image in req.images:
            contents.append(image_ref_to_content(image.ref))
        message = Message(role="user", contents=contents)

        collected: list[object] = []
        response_id: str | None = None
        async for update in agent.run(message, stream=True):
            response_id = getattr(update, "response_id", None) or response_id
            collected.extend(_iter_image_outputs(update.contents))

        if not collected:
            raise RuntimeError("no image content found in the model response")
        final = collected[-1]
        final_uri = getattr(final, "uri", None)
        if not final_uri:
            raise RuntimeError("final image content has no data URI")

        if out.suffix == "":
            ext = _extension_for(getattr(final, "media_type", None), req.output_format)
            out = out.with_suffix(f".{ext}")
        size_bytes = _save_data_uri(final_uri, out)
        return ImageGenResult(
            image_path=str(out),
            size_bytes=size_bytes,
            response_id=response_id,
        )


class RoutinVideoAdapter(VideoAdapter):
    """Volcengine Ark image+text → video via the routin.ai gateway."""

    def __init__(self) -> None:
        from volcenginesdkarkruntime import Ark

        settings = get_settings()
        self._client = Ark(
            base_url=settings.routin_video_base_url,
            api_key=_require_api_key(),
        )
        self._default_model = settings.routin_video_model

    async def submit(self, req: VideoGenRequest) -> VideoSubmitResult:
        kwargs: dict = {
            "model": req.model or self._default_model,
            "content": _build_content(req),
        }
        for key in (
            "resolution",
            "ratio",
            "duration",
            "seed",
            "camera_fixed",
            "generate_audio",
            "service_tier",
        ):
            value = getattr(req, key)
            if value is not None:
                kwargs[key] = value

        result = await asyncio.to_thread(
            self._client.content_generation.tasks.create, **kwargs
        )
        return VideoSubmitResult(provider_task_id=result.id)

    async def poll(self, provider_task_id: str) -> VideoPollResult:
        result = await asyncio.to_thread(
            self._client.content_generation.tasks.get, task_id=provider_task_id
        )
        status = getattr(result, "status", None) or "unknown"
        if status not in _TERMINAL:
            return VideoPollResult(status=status)
        if status == "succeeded":
            content = getattr(result, "content", None)
            video_url = getattr(content, "video_url", None) if content else None
            return VideoPollResult(status=status, video_url=video_url)
        err = getattr(result, "error", None)
        message = getattr(err, "message", None) if err else None
        return VideoPollResult(status=status, error=message)
