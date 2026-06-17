"""Adapter contracts: the minimal generation interfaces (docs/02).

Defines the smallest useful "generate" surface for each modality so the pipeline
and services face a stable ``submit``/``poll`` (video) or ``generate``
(text/image) regardless of the channel behind it. Request/response types are
pydantic models so they serialize straight into ``GenerationJob.request``.

Text and image generation are synchronous in the current slice; video stays
split into submit/poll because the provider exposes a long-running task API.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field, model_validator


class TextGenRequest(BaseModel):
    """Text → text request compiled from a TEXT_GEN canvas node."""

    prompt: str
    system_prompt: str = "You are a helpful assistant."
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    reasoning_effort: str | None = "medium"


class TextGenResult(BaseModel):
    """Result of a synchronous text generation."""

    text: str
    model: str | None = None


class ImageRef(BaseModel):
    """Reference image accepted by the image generation PoC."""

    ref: str


class ImageGenRequest(BaseModel):
    """Text + optional image refs → image request for IMAGE_GEN nodes."""

    prompt: str
    images: list[ImageRef] = Field(default_factory=list)
    model: str | None = None
    size: str | None = None
    quality: str | None = None
    output_format: str | None = None
    background: str | None = None
    moderation: str | None = None
    output_compression: int | None = None


class ImageGenResult(BaseModel):
    """Result of a synchronous image generation."""

    image_path: str
    size_bytes: int
    response_id: str | None = None


class TextAdapter(ABC):
    """Async text generation, matching the already-verified textgen PoC shape."""

    @abstractmethod
    async def generate(self, req: TextGenRequest) -> TextGenResult: ...


class ImageAdapter(ABC):
    """Async image generation, matching the already-verified imagegen2 PoC shape."""

    @abstractmethod
    async def generate(self, req: ImageGenRequest, *, out: Path) -> ImageGenResult:
        ...


class VideoSlotKind(StrEnum):
    """Image slot roles for a video request (test/videogen.py)."""

    REFERENCE = "reference_image"
    FIRST_FRAME = "first_frame"
    LAST_FRAME = "last_frame"


class VideoImageSlot(BaseModel):
    """One image fed to the video model: local path / http(s) URL / data URI."""

    ref: str
    kind: VideoSlotKind = VideoSlotKind.REFERENCE


class VideoContentType(StrEnum):
    """Ordered multimodal content item kinds for video generation."""

    TEXT = "text"
    IMAGE = "image"


class VideoContentItem(BaseModel):
    """One ordered input block compiled from a VIDEO_GEN node's in-edges."""

    type: VideoContentType
    text: str | None = None
    image: VideoImageSlot | None = None

    @model_validator(mode="after")
    def _payload_matches_type(self) -> "VideoContentItem":
        if self.type == VideoContentType.TEXT:
            if not self.text:
                raise ValueError("text content item requires text")
            if self.image is not None:
                raise ValueError("text content item cannot carry an image")
        if self.type == VideoContentType.IMAGE:
            if self.image is None:
                raise ValueError("image content item requires image")
            if self.text is not None:
                raise ValueError("image content item cannot carry text")
        return self


class VideoGenRequest(BaseModel):
    """Image+text → video request. Mirrors the verified PoC parameter subset."""

    prompt: str
    images: list[VideoImageSlot] = Field(default_factory=list)
    ordered_content: list[VideoContentItem] = Field(default_factory=list)
    model: str | None = None
    resolution: str | None = None  # 480p / 720p / 1080p
    ratio: str | None = None  # 16:9 / 9:16 / 1:1
    duration: int | None = None  # seconds, >= 4
    seed: int | None = None
    camera_fixed: bool | None = None
    generate_audio: bool | None = None
    service_tier: str | None = None  # default / flex (queued, cheaper)

    @model_validator(mode="after")
    def _slots_exclusive(self) -> "VideoGenRequest":
        # Ark server rule: keyframe slots cannot mix with reference slots
        # (test/videogen.py). Surface the error at request-construction time.
        kinds = {s.kind for s in self.images}
        for item in self.ordered_content:
            if item.image is not None:
                kinds.add(item.image.kind)
        keyframe = {VideoSlotKind.FIRST_FRAME, VideoSlotKind.LAST_FRAME}
        if keyframe & kinds and VideoSlotKind.REFERENCE in kinds:
            raise ValueError(
                "first/last frame slots cannot be combined with reference slots"
            )
        return self


class VideoSubmitResult(BaseModel):
    """Result of submitting a video task."""

    provider_task_id: str


class VideoPollResult(BaseModel):
    """Result of polling a video task."""

    status: str  # queued/running/succeeded/failed/canceled
    video_url: str | None = None
    error: str | None = None


class VideoAdapter(ABC):
    """Async image+text → video generation, split into submit + poll."""

    @abstractmethod
    async def submit(self, req: VideoGenRequest) -> VideoSubmitResult: ...

    @abstractmethod
    async def poll(self, provider_task_id: str) -> VideoPollResult: ...

    async def download(self, video_url: str, out: Path) -> Path:
        """Download a finished clip to ``out``. Default streams over HTTP."""
        import urllib.request

        out.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(video_url) as resp, open(out, "wb") as f:  # noqa: S310
            while chunk := resp.read(1 << 16):
                f.write(chunk)
        return out
