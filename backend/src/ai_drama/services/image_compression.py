"""Image delivery compression for generated canvas outputs.

Adapters archive their provider output first. This module then creates the
smaller working copy that downstream image/video generation nodes consume, so
multi-image payloads stay bounded while the original file remains available for
manual inspection and future reprocessing.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


@dataclass(frozen=True)
class CompressedImageResult:
    """Structured result for the archived raw image and delivered working copy."""

    image_path: Path
    size_bytes: int
    raw_image_path: Path
    raw_size_bytes: int
    target_bytes: int
    format: str
    lossless: bool
    quality: int | None
    scale: float


@dataclass(frozen=True)
class _Candidate:
    data: bytes
    format: str
    lossless: bool
    quality: int | None
    scale: float

    @property
    def size_bytes(self) -> int:
        return len(self.data)


def compress_image_for_delivery(
    raw_path: str | Path,
    *,
    output_stem: Path,
    target_bytes: int = 512 * 1024,
) -> CompressedImageResult:
    """Create a compact PNG/JPEG/WebP working copy for downstream payloads.

    The function is intentionally conservative: copy/optimize losslessly first,
    try lossless WebP when the source is close enough to the target, then
    gradually lower WebP quality and dimensions until the target is reached. If
    an extremely noisy image still cannot fit, the smallest candidate is kept
    instead of failing an otherwise successful generation job.
    """

    raw_image_path = Path(raw_path)
    raw_size_bytes = raw_image_path.stat().st_size
    with Image.open(raw_image_path) as opened:
        source_format = _normalize_format(opened.format, raw_image_path)
        if source_format not in {"PNG", "WEBP", "JPEG"}:
            raise ValueError(
                f"unsupported image format {source_format!r}; "
                "expected png, webp, jpg, or jpeg"
            )
        image = ImageOps.exif_transpose(opened)
        image.load()

    candidates = _lossless_candidates(
        image,
        source_format=source_format,
        raw_data=raw_image_path.read_bytes(),
        target_bytes=target_bytes,
    )
    best = min(candidates, key=lambda c: c.size_bytes)
    under_target = [
        candidate for candidate in candidates if candidate.size_bytes <= target_bytes
    ]
    if under_target:
        best = min(under_target, key=lambda c: (not c.lossless, c.size_bytes))
    else:
        for scale in (1.0, 0.75, 0.6, 0.5, 0.4, 0.33, 0.25): # SCALE_STEPS
            for quality in (88, 80, 72, 64, 56, 48, 40): # QUALITY_STEPS
                candidate = _encode_candidate(
                    image,
                    "WEBP",
                    lossless=False,
                    quality=quality,
                    scale=scale,
                )
                if candidate.size_bytes < best.size_bytes:
                    best = candidate
                if candidate.size_bytes <= target_bytes:
                    best = candidate
                    break
            if best.size_bytes <= target_bytes:
                break

    output_path = output_stem.with_suffix(f".{_extension_for(best.format)}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(best.data)
    return CompressedImageResult(
        image_path=output_path,
        size_bytes=best.size_bytes,
        raw_image_path=raw_image_path,
        raw_size_bytes=raw_size_bytes,
        target_bytes=target_bytes,
        format=best.format.lower(),
        lossless=best.lossless,
        quality=best.quality,
        scale=best.scale,
    )


def _lossless_candidates(
    image: Image.Image,
    *,
    source_format: str,
    raw_data: bytes,
    target_bytes: int,
) -> list[_Candidate]:
    candidates = [
        _Candidate(
            data=raw_data,
            format=source_format,
            lossless=True,
            quality=None,
            scale=1.0,
        )
    ]
    can_afford_lossless_reencode = (
        len(raw_data) <= target_bytes * 2 # LOSSLESS_REENCODE_MAX_RATIO
    )
    if source_format == "PNG" or (
        source_format == "WEBP" and can_afford_lossless_reencode
    ):
        candidates.append(
            _encode_candidate(
                image,
                source_format,
                lossless=True,
                quality=None,
                scale=1.0,
            )
        )
    if source_format != "WEBP" and can_afford_lossless_reencode:
        candidates.append(
            _encode_candidate(
                image,
                "WEBP",
                lossless=True,
                quality=None,
                scale=1.0,
            )
        )
    return candidates


def _encode_candidate(
    image: Image.Image,
    image_format: str,
    *,
    lossless: bool,
    quality: int | None,
    scale: float,
) -> _Candidate:
    working = _scaled_image(image, scale)
    save_image = _prepare_for_format(working, image_format)
    params: dict[str, object]
    if image_format == "PNG":
        params = {"optimize": True, "compress_level": 9}
    elif image_format == "WEBP":
        params = {"method": 6, "lossless": lossless}
        params["quality"] = 100 if lossless else quality
    elif image_format == "JPEG":
        params = {
            "optimize": True,
            "progressive": True,
            "quality": quality or 95,
        }
    else:  # pragma: no cover - callers normalize before dispatch.
        raise ValueError(f"unsupported image format: {image_format}")

    buffer = BytesIO()
    save_image.save(buffer, format=image_format, **params)
    return _Candidate(
        data=buffer.getvalue(),
        format=image_format,
        lossless=lossless,
        quality=quality,
        scale=scale,
    )


def _scaled_image(image: Image.Image, scale: float) -> Image.Image:
    if scale >= 1.0:
        return image.copy()
    width = max(1, round(image.width * scale))
    height = max(1, round(image.height * scale))
    return image.resize((width, height), Image.Resampling.LANCZOS)


def _prepare_for_format(image: Image.Image, image_format: str) -> Image.Image:
    if image_format == "JPEG":
        if image.mode in {"RGBA", "LA"} or (
            image.mode == "P" and "transparency" in image.info
        ):
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            background.alpha_composite(rgba)
            return background.convert("RGB")
        if image.mode != "RGB":
            return image.convert("RGB")
    if image_format == "WEBP" and image.mode == "CMYK":
        return image.convert("RGB")
    return image


def _normalize_format(image_format: str | None, path: Path) -> str:
    normalized = (image_format or path.suffix.lstrip(".")).upper()
    if normalized == "JPG":
        return "JPEG"
    return normalized


def _extension_for(image_format: str) -> str:
    if image_format == "JPEG":
        return "jpg"
    return image_format.lower()
