"""Model-catalog tests.

The YAML catalog is the source of truth for generation parameter controls, but
runtime code consumes only a typed Pydantic view. These tests keep that boundary
explicit so UI/API/compiler defaults cannot drift into module-local constants.
"""

from __future__ import annotations

import yaml

from ai_drama.model_catalog import CATALOG_DIR, get_seedance_video_settings


def test_seedance_video_settings_are_loaded_from_catalog() -> None:
    settings = get_seedance_video_settings()

    assert settings.duration.min == 4
    assert settings.duration.max == 15
    assert settings.duration.step == 1
    assert settings.duration.default == 15
    assert settings.ratio.options == ["9:16", "16:9", "1:1"]
    assert settings.ratio.default == "9:16"
    assert settings.resolution.options == ["480p", "720p", "1080p"]
    assert settings.resolution.default == "720p"


def test_seedance_video_settings_api(client) -> None:
    resp = client.get("/api/model-catalog/seedance/video-settings")

    assert resp.status_code == 200
    assert resp.json() == {
        "duration": {"min": 4, "max": 15, "step": 1, "default": 15},
        "ratio": {
            "options": ["9:16", "16:9", "1:1"],
            "default": "9:16",
        },
        "resolution": {
            "options": ["480p", "720p", "1080p"],
            "default": "720p",
        },
    }


def test_grok_video_catalog_matches_routin_xai_adapter_contract() -> None:
    """The Grok catalog captures the request subset implemented by RoutinVideoAdapter2."""

    catalog = yaml.safe_load(
        (CATALOG_DIR / "grok-video.yaml").read_text(encoding="utf-8")
    )
    model = catalog["models"][0]
    runtime = model["runtime"]["routin"]
    modes = model["modes"]

    assert catalog["family"] == "grok-video"
    assert catalog["supported_modalities"] == ["t2v", "i2v", "r2v"]
    assert model["id"] == "grok-imagine-video"
    assert runtime["base_url"] == "https://api.routin.ai/xai/v1"
    assert runtime["submit_path"] == "/videos/generations"
    assert runtime["poll_path"] == "/videos/{request_id}"
    assert runtime["terminal_statuses"] == ["done", "failed", "expired"]

    assert modes["t2v"]["duration"] == {
        "type": "slider",
        "min": 1,
        "max": 15,
        "step": 1,
        "default": 5,
    }
    assert modes["i2v"]["inputs"]["first_frame"] == {
        "max": 1,
        "reference_type": "image",
        "request_field": "image",
    }
    assert modes["r2v"]["duration"]["max"] == 10
    assert modes["r2v"]["inputs"]["reference_images"] == {
        "max": 7,
        "reference_type": "image",
        "request_field": "reference_images",
    }
    assert modes["r2v"]["params"]["ratio"]["request_field"] == "aspect_ratio"
    assert modes["r2v"]["params"]["resolution"]["options"] == ["480p", "720p"]
