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
import json
import mimetypes
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping
from urllib.parse import quote, unquote, urlparse

import httpx

from ai_drama.adapters.base import (
    ImageAdapter,
    ImageGenRequest,
    ImageGenResult,
    MultimodalContentType,
    TextAdapter,
    TextGenRequest,
    TextGenResult,
    VideoAdapter,
    VideoGenRequest,
    VideoPollResult,
    VideoSubmitResult,
)
from ai_drama.config import GENERATED_IMAGES_DIR, get_settings


def _static_image_path(ref: str) -> Path | None:
    """Map the backend's public ``/images/...`` URL back to its stored file."""
    parsed = urlparse(ref)
    if parsed.scheme and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
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
    for item in req.ordered_content:
        if item.type == MultimodalContentType.TEXT:
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


def _iter_image_content_blocks(
    req: ImageGenRequest,
) -> Iterator[tuple[MultimodalContentType, str]]:
    """Yield IMAGE_GEN input blocks in provider submission order."""
    for item in req.ordered_content:
        if item.type == MultimodalContentType.TEXT and item.text is not None:
            yield MultimodalContentType.TEXT, item.text
        elif item.image is not None:
            yield MultimodalContentType.IMAGE, item.image.ref


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

        contents = []
        for kind, value in _iter_image_content_blocks(req):
            if kind == MultimodalContentType.TEXT:
                contents.append(Content.from_text(text=value))
            else:
                contents.append(image_ref_to_content(value))
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
        if status not in {"succeeded", "failed", "canceled"}:
            return VideoPollResult(status=status)
        if status == "succeeded":
            content = getattr(result, "content", None)
            video_url = getattr(content, "video_url", None) if content else None
            return VideoPollResult(status=status, video_url=video_url)
        err = getattr(result, "error", None)
        message = getattr(err, "message", None) if err else None
        return VideoPollResult(status=status, error=message)


class RoutinVideoAdapter2(VideoAdapter):
    """Temporary routin xAI-compatible video adapter based on xAI."""

    def __init__(self) -> None:
        self._base_url = "https://api.routin.ai/xai/v1"
        self._api_key = _require_api_key()
        self._default_model = "grok-imagine-video"
        self._request_timeout = 360.0

    @staticmethod
    def _build_payload(req: VideoGenRequest, *, model: str) -> dict[str, Any]:
        prompt_parts: list[str] = []
        image_url: str | None = None
        reference_image_urls: list[str] = []

        for item in req.ordered_content:
            if item.type == MultimodalContentType.TEXT and item.text:
                prompt_parts.append(item.text)
                continue
            if item.image is None:
                continue

            url = _image_ref_to_url(item.image.ref)
            if item.image.kind.value == "reference_image":
                reference_image_urls.append(url)
            elif item.image.kind.value == "first_frame":
                if image_url is not None:
                    raise ValueError(
                        "xAI video request accepts only one first_frame image"
                    )
                image_url = url
            else:
                raise ValueError("xAI video request does not support last_frame images")

        if image_url is not None and reference_image_urls:
            raise ValueError(
                "xAI video request cannot mix first_frame and reference images"
            )
        if len(reference_image_urls) > 7:
            raise ValueError(
                "xAI video request accepts at most 7 reference images, "
                f"got {len(reference_image_urls)}"
            )
        if reference_image_urls and req.duration is not None and req.duration > 10:
            raise ValueError(
                "xAI video request duration must be <= 10 when reference images are used"
            )

        prompt = "\n".join(prompt_parts).strip()
        if not prompt:
            raise ValueError("xAI video request requires a text prompt")

        payload: dict[str, Any] = {"model": model, "prompt": prompt}
        if image_url is not None:
            payload["image"] = {"url": image_url}
        if reference_image_urls:
            payload["reference_images"] = [{"url": url} for url in reference_image_urls]
        if req.duration is not None:
            payload["duration"] = req.duration
        if req.ratio is not None:
            payload["aspect_ratio"] = req.ratio
        if req.resolution is not None:
            payload["resolution"] = req.resolution
        return payload

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(
            base_url=self._base_url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            timeout=self._request_timeout,
        ) as client:
            try:
                response = await client.request(method, path, json=payload)
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                body = exc.response.text
                raise RuntimeError(
                    f"{method} {exc.request.url} failed: "
                    f"HTTP {exc.response.status_code}: {body}"
                ) from exc
            except httpx.RequestError as exc:
                raise RuntimeError(f"{method} {exc.request.url} failed: {exc}") from exc

        try:
            result = response.json()
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"{method} {response.request.url} returned non-JSON response: "
                f"{response.text[:500]}"
            ) from exc
        if not isinstance(result, dict):
            raise RuntimeError(
                f"{method} {response.request.url} returned unexpected JSON: {result!r}"
            )
        return result

    @staticmethod
    def _request_id(data: Mapping[str, Any]) -> str:
        request_id = data.get("request_id") or data.get("id")
        if isinstance(request_id, str) and request_id:
            return request_id
        raise RuntimeError(f"xAI video response did not include request_id: {data!r}")

    @staticmethod
    def _nested_mapping(data: Mapping[str, Any], key: str) -> Mapping[str, Any] | None:
        value = data.get(key)
        return value if isinstance(value, Mapping) else None

    @classmethod
    def _video_url(cls, data: Mapping[str, Any]) -> str:
        for key in ("video_url", "output_url", "public_url"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value
        for container_key in ("video", "result", "output", "content", "data"):
            container = cls._nested_mapping(data, container_key)
            if container is None:
                continue
            try:
                return cls._video_url(container)
            except RuntimeError:
                pass
        value = data.get("url")
        if isinstance(value, str) and value:
            return value
        raise RuntimeError(
            f"xAI completed response did not include a video URL: {data!r}"
        )

    @staticmethod
    def _error_message(data: Mapping[str, Any]) -> str:
        err = data.get("error")
        if isinstance(err, Mapping):
            code = str(err.get("code") or "UNKNOWN")
            message = str(err.get("message") or err)
            return f"{code}: {message}"
        if err:
            return str(err)
        return str(data)

    async def submit(self, req: VideoGenRequest) -> VideoSubmitResult:
        model = req.model or self._default_model
        payload = self._build_payload(req, model=model)
        data = await self._request_json(
            "POST",
            "/videos/generations",
            payload=payload,
        )
        return VideoSubmitResult(provider_task_id=self._request_id(data))

    async def poll(self, provider_task_id: str) -> VideoPollResult:
        data = await self._request_json(
            "GET",
            f"/videos/{quote(provider_task_id, safe='')}",
        )
        status = str(data.get("status") or "").lower() or "unknown"
        if status in {"done", "succeeded", "success"}:
            return VideoPollResult(status="succeeded", video_url=self._video_url(data))
        if status in {"failed", "error"}:
            return VideoPollResult(status="failed", error=self._error_message(data))
        if status in {"expired"}:
            return VideoPollResult(status="failed", error="xAI video task expired")
        return VideoPollResult(status=status)
