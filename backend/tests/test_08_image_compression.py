"""Generated image compression keeps downstream payloads bounded.

Image jobs archive the raw provider output under ``outputs/images/raw`` and
return a compact working copy for preview plus image/video follow-up nodes.
These tests lock both the compression helper and the job-service boundary.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from ai_drama.adapters.base import (
    ImageContentItem,
    ImageGenRequest,
    MultimodalContentType,
)
from ai_drama.services.image_compression import compress_image_for_delivery


def test_compress_image_for_delivery_reaches_target_with_working_copy(tmp_path):
    raw_dir = tmp_path / "images" / "raw"
    raw_dir.mkdir(parents=True)
    raw_path = raw_dir / "noisy.png"
    image = Image.effect_noise((640, 640), 100).convert("RGB")
    image.save(raw_path, format="PNG")
    target_bytes = 32 * 1024

    result = compress_image_for_delivery(
        raw_path,
        output_stem=tmp_path / "images" / "generated",
        target_bytes=target_bytes,
    )

    assert raw_path.exists()
    assert result.raw_image_path == raw_path
    assert result.raw_size_bytes == raw_path.stat().st_size
    assert result.image_path.parent == tmp_path / "images"
    assert result.image_path.parent != raw_path.parent
    assert result.image_path.suffix in {".png", ".webp", ".jpg"}
    assert result.size_bytes == result.image_path.stat().st_size
    assert result.size_bytes <= target_bytes


def test_compress_image_for_delivery_prefers_lossless_when_small_enough(tmp_path):
    raw_path = tmp_path / "images" / "raw" / "tiny.png"
    raw_path.parent.mkdir(parents=True)
    image = Image.new("RGBA", (16, 16), (10, 120, 240, 255))
    image.save(raw_path, format="PNG")

    result = compress_image_for_delivery(
        raw_path,
        output_stem=tmp_path / "images" / "tiny",
        target_bytes=raw_path.stat().st_size + 1024,
    )

    assert result.lossless is True
    assert result.size_bytes <= result.target_bytes
    assert result.image_path.read_bytes()


@pytest.mark.asyncio
async def test_image_job_archives_raw_and_returns_compressed_copy(
    client, tmp_path, monkeypatch
):
    from ai_drama.db import SessionLocal
    from ai_drama.services import jobs

    images_dir = tmp_path / "images"
    monkeypatch.setattr(jobs, "IMAGES_DIR", images_dir)
    monkeypatch.setattr(jobs, "RAW_IMAGES_DIR", images_dir / "raw")

    req = ImageGenRequest(
        ordered_content=[
            ImageContentItem(
                type=MultimodalContentType.TEXT,
                text="single red lantern",
            )
        ],
    )

    with SessionLocal() as db:
        job = await jobs.generate_image_job(
            db,
            episode_id=1,
            output_node_id="image_gen-1",
            request=req,
            channel="mock",
        )

    assert job.result is not None
    raw_path = Path(job.result["raw_image_path"])
    image_path = Path(job.result["image_path"])
    assert raw_path.parent == images_dir / "raw"
    assert image_path.parent == images_dir
    assert raw_path != image_path
    assert raw_path.exists()
    assert image_path.exists()
    assert job.result["image_url"] == f"/images/{image_path.name}"
    assert job.result["raw_size_bytes"] == raw_path.stat().st_size
    assert job.result["size_bytes"] == image_path.stat().st_size
    assert job.result["compression"]["target_bytes"] > 0
