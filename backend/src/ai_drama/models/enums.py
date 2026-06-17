"""Controlled vocabularies shared across the data model.

These enums turn the storyboard schema's string fields (docs/01 §2.1, sourced
from test/instructions/06) into typed values so downstream prompts and the
frontend cannot drift onto unspecified terms. The canvas node model is a
generic compute graph (ADR-006): data nodes carry a value, adapter nodes run a
generation and map 1:1 to the three adapters.
"""

from __future__ import annotations

from enum import StrEnum


class AssetKind(StrEnum):
    """Kind of visual asset (04/05 outputs)."""

    CHARACTER = "character"
    PROP = "prop"
    SCENE = "scene"


class PortType(StrEnum):
    """Port / data type. Edges are validated for type compatibility."""

    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"


class NodeKind(StrEnum):
    """Canvas node kinds — a generic compute graph (ADR-006, docs/01 §2.3).

    Data nodes (TEXT/IMAGE/VIDEO) carry a value and expose an output port.
    Adapter nodes (*_GEN) run one generation and map 1:1 to the adapters in
    docs/02: TEXT_GEN→TextAdapter, IMAGE_GEN→ImageAdapter, VIDEO_GEN→VideoAdapter.
    """

    # data nodes
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    # adapter nodes
    TEXT_GEN = "text_gen"  # text -> text
    IMAGE_GEN = "image_gen"  # text + image* (optional) -> image
    VIDEO_GEN = "video_gen"  # text + image* (optional) -> video


class JobKind(StrEnum):
    """Generation job modality."""

    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"


class JobStatus(StrEnum):
    """Generation job lifecycle (docs/03 §4.1).

    Terminal states mirror the PoC videogen contract
    (test/videogen.py TERMINAL_STATUSES).
    """

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"

    @property
    def is_terminal(self) -> bool:
        return self in {JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELED}


# Output data type produced by each node kind. For adapter nodes this is the
# type of their generated product.
NODE_OUTPUT_TYPE: dict[NodeKind, PortType] = {
    NodeKind.TEXT: PortType.TEXT,
    NodeKind.IMAGE: PortType.IMAGE,
    NodeKind.VIDEO: PortType.VIDEO,
    NodeKind.TEXT_GEN: PortType.TEXT,
    NodeKind.IMAGE_GEN: PortType.IMAGE,
    NodeKind.VIDEO_GEN: PortType.VIDEO,
}

# Input port types accepted by each adapter node. Data nodes accept no inputs
# (absent from this map).
ADAPTER_INPUT_TYPES: dict[NodeKind, set[PortType]] = {
    NodeKind.TEXT_GEN: {PortType.TEXT},
    NodeKind.IMAGE_GEN: {PortType.TEXT, PortType.IMAGE},
    NodeKind.VIDEO_GEN: {PortType.TEXT, PortType.IMAGE},
}

# Adapter node kind -> the job modality it produces.
ADAPTER_NODE_JOB_KIND: dict[NodeKind, JobKind] = {
    NodeKind.TEXT_GEN: JobKind.TEXT,
    NodeKind.IMAGE_GEN: JobKind.IMAGE,
    NodeKind.VIDEO_GEN: JobKind.VIDEO,
}


def is_adapter_node(kind: NodeKind) -> bool:
    """True if the node kind runs a generation (has input ports)."""
    return kind in ADAPTER_INPUT_TYPES
