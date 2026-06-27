"""Typed application configuration sourced from environment / .env.

Centralizes all runtime configuration in one pydantic-settings model so secrets
(API keys) and endpoints are never hardcoded the way the PoC scripts under
``test/`` were. Values resolve from environment variables (optionally an
``.env`` file at the backend root); the routin gateway defaults mirror the
verified PoC endpoints so a fresh checkout runs without extra wiring, while the
API key stays unset until provided.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Backend project root (…/backend), used to anchor the SQLite file and .env.
BACKEND_ROOT = Path(__file__).resolve().parents[2]
OUTPUTS_ROOT = BACKEND_ROOT.parent / "outputs"
GENERATED_CLIPS_DIR = OUTPUTS_ROOT / "clips"
GENERATED_IMAGES_DIR = OUTPUTS_ROOT / "images"


class Settings(BaseSettings):
    """Top-level settings. Nested provider settings are composed in as needed."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- storage ---
    database_url: str = Field(
        default=f"sqlite:///{(BACKEND_ROOT / 'ai_drama.db').as_posix()}",
        description="SQLAlchemy database URL. Defaults to a local SQLite file.",
    )

    # --- routin.ai gateway (single channel for v1, see docs/02_adapter.md) ---
    routin_api_key: str | None = Field(default=None, description="routin.ai API key.")
    routin_text_base_url: str = "https://api.routin.ai/v1"
    routin_image_base_url: str = "https://api.routin.ai/v1"
    routin_video_base_url: str = "https://api.routin.ai/api/v3"
    routin_text_model: str = "deepseek-v4-pro"
    routin_image_model: str = "gpt-5.4"
    routin_video_model: str = "doubao-seedance-2-0-fast-260128"

    # --- server ---
    cors_origins: list[str] = Field(
        default=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://localhost:3000",
        ],
        description="Allowed CORS origins for the dev frontend.",
    )


@lru_cache
def get_settings() -> Settings:
    """Return a process-wide cached Settings instance."""
    return Settings()
