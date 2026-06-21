"""Mock generation adapters — lets the slice run with no network or key.

Text/image resolve synchronously. Video returns a deterministic task id,
reports ``succeeded`` after a couple of polls, and writes a tiny but valid MP4
on download. Selected via channel ``"mock"`` (docs/05 §2: offline logic runs
without burning tokens).
"""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path

from ai_drama.adapters.base import (
    ImageAdapter,
    ImageGenRequest,
    ImageGenResult,
    TextAdapter,
    TextGenRequest,
    TextGenResult,
    VideoAdapter,
    VideoGenRequest,
    VideoPollResult,
    VideoSubmitResult,
)

# A minimal valid MP4 (ftyp + tiny moov/mdat), base64-encoded. ~250 bytes.
# Enough for <video> to recognize the container; it renders a blank frame.
_TINY_MP4_B64 = (
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAA"
    "Am1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAAB"
    "AAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAACAAAAAA=="
)

_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AA"
    "AAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)


class MockTextAdapter(TextAdapter):
    """Deterministic text adapter for offline tests and local UI smoke checks."""

    async def generate(self, req: TextGenRequest) -> TextGenResult:
        texts = [text.strip() for text in req.input_texts]
        text = "\n\n".join(text for text in texts if text) or "empty prompt"
        return TextGenResult(text=f"[mock text] {text}", model=req.model or "mock")


class MockImageAdapter(ImageAdapter):
    """Deterministic image adapter that writes a tiny PNG to the requested path."""

    async def generate(self, req: ImageGenRequest, *, out: Path) -> ImageGenResult:
        if out.suffix == "":
            out = out.with_suffix(".png")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(_TINY_PNG_B64))
        digest = hashlib.sha1(req.model_dump_json().encode("utf-8")).hexdigest()[:12]
        return ImageGenResult(
            image_path=str(out),
            size_bytes=out.stat().st_size,
            response_id=f"mock-image-{digest}",
        )


class MockVideoAdapter(VideoAdapter):
    """In-process fake video channel. Stateful poll counter per task id."""

    def __init__(self) -> None:
        # task_id -> remaining polls before it reports succeeded
        self._pending: dict[str, int] = {}
        self._counter = 0

    async def submit(self, req: VideoGenRequest) -> VideoSubmitResult:
        self._counter += 1
        task_id = f"mock-task-{self._counter}"
        # Report "running" for one poll, then "succeeded".
        self._pending[task_id] = 1
        return VideoSubmitResult(provider_task_id=task_id)

    async def poll(self, provider_task_id: str) -> VideoPollResult:
        remaining = self._pending.get(provider_task_id, 0)
        if remaining > 0:
            self._pending[provider_task_id] = remaining - 1
            return VideoPollResult(status="running")
        return VideoPollResult(
            status="succeeded",
            video_url=f"mock://clip/{provider_task_id}.mp4",
        )

    async def download(self, video_url: str, out: Path) -> Path:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(_TINY_MP4_B64))
        return out
