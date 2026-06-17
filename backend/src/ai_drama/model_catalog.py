"""Typed model-catalog accessors.

The YAML catalog is the source of truth for provider/model parameter bounds.
This module intentionally exposes only the typed slice the runtime currently
uses, so service code receives Pydantic models instead of weak nested dicts.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


CATALOG_DIR = Path(__file__).resolve().parent / "config" / "model_catalog"
SEEDANCE_CATALOG_PATH = CATALOG_DIR / "seedance.yaml"
SEEDANCE_VIDEO_MODEL_ID = "seedance/seedance-2.0-video"


class CatalogError(ValueError):
    """Raised when a model catalog file cannot satisfy the typed runtime view."""


class DurationSettings(BaseModel):
    """Duration control bounds consumed by VideoGenNode and request compiler."""

    model_config = ConfigDict(extra="ignore")

    min: int = Field(ge=1)
    max: int = Field(ge=1)
    step: int = Field(default=1, ge=1)
    default: int = Field(ge=1)

    @model_validator(mode="after")
    def _default_within_bounds(self) -> "DurationSettings":
        if self.min > self.max:
            raise ValueError("duration min cannot exceed max")
        if not self.min <= self.default <= self.max:
            raise ValueError("duration default must be within min/max bounds")
        return self


class ResolutionSettings(BaseModel):
    """Resolution options consumed by VideoGenNode and request compiler."""

    model_config = ConfigDict(extra="ignore")

    options: list[str] = Field(min_length=1)
    default: str

    @model_validator(mode="after")
    def _default_is_supported(self) -> "ResolutionSettings":
        if len(set(self.options)) != len(self.options):
            raise ValueError("resolution options must be unique")
        if self.default not in self.options:
            raise ValueError("resolution default must be one of options")
        return self


class VideoGenSettings(BaseModel):
    """Typed generation settings exposed to compiler and frontend."""

    duration: DurationSettings
    resolution: ResolutionSettings


class _VideoModeParams(BaseModel):
    """The subset of a catalog mode's params used by video generation."""

    model_config = ConfigDict(extra="ignore")

    resolution: ResolutionSettings


class _VideoMode(BaseModel):
    """The subset of a Seedance mode used by VideoGenNode."""

    model_config = ConfigDict(extra="ignore")

    duration: DurationSettings
    params: _VideoModeParams

    def to_settings(self) -> VideoGenSettings:
        return VideoGenSettings(
            duration=self.duration,
            resolution=self.params.resolution,
        )


class _SeedanceModes(BaseModel):
    """Known Seedance mode names; extra future modes are ignored deliberately."""

    model_config = ConfigDict(extra="ignore")

    t2v: _VideoMode | None = None
    i2v: _VideoMode | None = None
    r2v: _VideoMode


class _SeedanceModel(BaseModel):
    """A catalog model entry with the mode subset used by this service."""

    model_config = ConfigDict(extra="ignore")

    id: str
    modes: _SeedanceModes


class _SeedanceCatalog(BaseModel):
    """Typed view over seedance.yaml, limited to runtime-owned fields."""

    model_config = ConfigDict(extra="ignore")

    family: str
    models: list[_SeedanceModel] = Field(min_length=1)

    def video_settings(self, model_id: str = SEEDANCE_VIDEO_MODEL_ID) -> VideoGenSettings:
        for model in self.models:
            if model.id == model_id:
                return model.modes.r2v.to_settings()
        raise CatalogError(f"Seedance model {model_id!r} not found")


@lru_cache
def load_seedance_catalog() -> _SeedanceCatalog:
    """Load and validate seedance.yaml into the typed catalog view."""
    try:
        raw = yaml.safe_load(SEEDANCE_CATALOG_PATH.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CatalogError(f"cannot read {SEEDANCE_CATALOG_PATH}") from exc

    if raw is None:
        raise CatalogError(f"{SEEDANCE_CATALOG_PATH} is empty")
    return _SeedanceCatalog.model_validate(raw)


def get_seedance_video_settings() -> VideoGenSettings:
    """Return the R2V VideoGenNode settings for the default Seedance model."""
    return load_seedance_catalog().video_settings()
