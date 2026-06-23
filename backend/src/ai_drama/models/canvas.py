"""Canvas pydantic schemas — the generic compute-graph DAG (ADR-001 + ADR-006).

The canvas is what the user sees; the adapters need ordered, typed inputs. This
module models the node inheritance as a flat DTO (``kind`` discriminates data vs
adapter nodes) plus ordered edges, and validates topology so the frontend can
only persist a graph the compiler (docs/01 §2.4) can consume: endpoints must
exist, the graph must be acyclic, and every edge must be port-type compatible
(an adapter node's input must accept the source node's output type; data nodes
accept no input).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator

from ai_drama.models.enums import (
    ADAPTER_INPUT_TYPES,
    NODE_OUTPUT_TYPE,
    NodeKind,
)


class CanvasNodePosition(BaseModel):
    """Canvas geometry for a node: location plus optional persisted size."""

    x: float = 0.0
    y: float = 0.0
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)

    @model_validator(mode="before")
    @classmethod
    def _coerce_legacy_tuple(cls, value: Any) -> Any:
        if isinstance(value, (list, tuple)) and len(value) == 2:
            return {"x": value[0], "y": value[1]}
        return value

    @model_validator(mode="after")
    def _validate_size_pair(self) -> "CanvasNodePosition":
        if (self.width is None) != (self.height is None):
            raise ValueError("canvas node width and height must be provided together")
        return self


class CanvasNode(BaseModel):
    """A node on the EP canvas (flat DTO over the Node hierarchy).

    Every node has id / name / position / data (the base ``Node`` fields).
    ``ref_id`` lets an IMAGE node reference a project-owned Asset
    (character/prop/scene semantics ride on Asset.kind) or a TEXT node bind a
    Segment.
    """

    id: str
    kind: NodeKind
    name: str = ""
    ref_id: int | None = None  # IMAGE→Asset.id / TEXT→Segment.id
    position: CanvasNodePosition = Field(default_factory=CanvasNodePosition)
    data: dict = Field(default_factory=dict)


class CanvasEdge(BaseModel):
    """A directed, ordered edge. ``order`` sequences multiple in-edges of the
    same adapter node so the compiler produces the fixed reference order."""

    id: str
    source: str
    target: str
    order: int = 0


class CanvasGraph(BaseModel):
    """The full EP canvas. Validates topology + port types (docs/01 §2.3)."""

    episode_id: int
    nodes: list[CanvasNode] = Field(default_factory=list)
    edges: list[CanvasEdge] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_topology(self) -> "CanvasGraph":
        by_id = {n.id: n for n in self.nodes}
        if len(by_id) != len(self.nodes):
            raise ValueError("duplicate node id")

        # Guard 1: edge endpoints must exist.
        for e in self.edges:
            if e.source not in by_id or e.target not in by_id:
                raise ValueError(f"edge {e.id} references a missing node")

        # Guard 2: acyclic (DAG).
        self._assert_acyclic()

        # Guard 3: port-type compatibility.
        for e in self.edges:
            src, tgt = by_id[e.source], by_id[e.target]
            if tgt.kind not in ADAPTER_INPUT_TYPES:
                raise ValueError(f"{tgt.kind} is a data node and accepts no input")
            out_type = NODE_OUTPUT_TYPE[src.kind]
            if out_type not in ADAPTER_INPUT_TYPES[tgt.kind]:
                raise ValueError(f"incompatible: {src.kind}({out_type}) -> {tgt.kind}")
        return self

    def _assert_acyclic(self) -> None:
        adj: dict[str, list[str]] = {n.id: [] for n in self.nodes}
        for e in self.edges:
            adj[e.source].append(e.target)
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {n.id: WHITE for n in self.nodes}

        def visit(u: str) -> None:
            color[u] = GRAY
            for v in adj[u]:
                if color[v] == GRAY:
                    raise ValueError("canvas graph must be acyclic (cycle found)")
                if color[v] == WHITE:
                    visit(v)
            color[u] = BLACK

        for n in self.nodes:
            if color[n.id] == WHITE:
                visit(n.id)
