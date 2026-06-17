"""Adapter registry — a simple name → factory map, not a plugin framework.

Keeps adapter selection in one place so services request a channel by name
(docs/02 §4). The factory is lazy: the routin adapter is only constructed when
asked, so importing the registry never requires the Ark SDK or an API key.
Adding a channel is one line here plus a class implementing the base contract.
"""

from __future__ import annotations

from collections.abc import Callable

from ai_drama.adapters.base import ImageAdapter, TextAdapter, VideoAdapter
from ai_drama.adapters.mock import MockImageAdapter, MockTextAdapter, MockVideoAdapter

DEFAULT_TEXT_CHANNEL = "mock"
DEFAULT_IMAGE_CHANNEL = "mock"
DEFAULT_VIDEO_CHANNEL = "mock"


def _make_routin_text() -> TextAdapter:
    from ai_drama.adapters.routin import RoutinTextAdapter

    return RoutinTextAdapter()


def _make_routin_image() -> ImageAdapter:
    from ai_drama.adapters.routin import RoutinImageAdapter

    return RoutinImageAdapter()


def _make_routin() -> VideoAdapter:
    from ai_drama.adapters.routin import RoutinVideoAdapter

    return RoutinVideoAdapter()


_TEXT_FACTORIES: dict[str, Callable[[], TextAdapter]] = {
    "mock": MockTextAdapter,
    "routin": _make_routin_text,
}

_IMAGE_FACTORIES: dict[str, Callable[[], ImageAdapter]] = {
    "mock": MockImageAdapter,
    "routin": _make_routin_image,
}

_VIDEO_FACTORIES: dict[str, Callable[[], VideoAdapter]] = {
    "mock": MockVideoAdapter,
    "routin": _make_routin,
}


def get_text_adapter(channel: str = DEFAULT_TEXT_CHANNEL) -> TextAdapter:
    """Return a text adapter for ``channel``. Raises KeyError if unknown."""
    try:
        return _TEXT_FACTORIES[channel]()
    except KeyError:
        raise KeyError(
            f"unknown text channel {channel!r}; "
            f"available: {sorted(_TEXT_FACTORIES)}"
        ) from None


def get_image_adapter(channel: str = DEFAULT_IMAGE_CHANNEL) -> ImageAdapter:
    """Return an image adapter for ``channel``. Raises KeyError if unknown."""
    try:
        return _IMAGE_FACTORIES[channel]()
    except KeyError:
        raise KeyError(
            f"unknown image channel {channel!r}; "
            f"available: {sorted(_IMAGE_FACTORIES)}"
        ) from None


def get_video_adapter(channel: str = DEFAULT_VIDEO_CHANNEL) -> VideoAdapter:
    """Return a video adapter for ``channel``. Raises KeyError if unknown."""
    try:
        return _VIDEO_FACTORIES[channel]()
    except KeyError:
        raise KeyError(
            f"unknown video channel {channel!r}; "
            f"available: {sorted(_VIDEO_FACTORIES)}"
        ) from None
