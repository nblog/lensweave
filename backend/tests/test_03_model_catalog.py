"""Model-catalog tests.

The YAML catalog is the source of truth for generation parameter controls, but
runtime code consumes only a typed Pydantic view. These tests keep that boundary
explicit so UI/API/compiler defaults cannot drift into module-local constants.
"""

from __future__ import annotations

from ai_drama.model_catalog import get_seedance_video_settings


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
