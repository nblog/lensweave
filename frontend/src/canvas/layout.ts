/**
 * Deterministic layered auto-layout (docs/06 §2 principle 3).
 *
 * The WebMCP tools never let the AI pass coordinates — positions are computed
 * here. Nodes are placed in columns by topological depth (a node sits one
 * column right of its deepest input), so a chain text -> text_gen -> image_gen
 * -> video_gen reads left-to-right and parallel inputs stack vertically.
 *
 * No extra dependency: a small longest-path layering over the existing edges.
 * Pure and stable — same graph in, same coordinates out — so an idempotent
 * tool re-run does not make nodes jump.
 */
import type { Edge } from "@xyflow/react";

import { edgeOrder, type CanvasNode } from "./graph";

const COLUMN_GAP = 280;
const ROW_GAP = 160;
const ORIGIN_X = 80;
const ORIGIN_Y = 70;

/**
 * Return a new node array with positions assigned by topological depth.
 * Nodes already laid out keep contributing their order; the function is
 * deterministic given (nodes, edges) and ignores prior coordinates.
 */
export function layoutGraph(
  nodes: CanvasNode[],
  edges: Edge[],
): CanvasNode[] {
  if (nodes.length === 0) return nodes;

  const depth = computeDepths(nodes, edges);

  // Group node ids by column (depth), preserving a stable intra-column order:
  // by incoming-edge order first (so an adapter's inputs stack in context
  // order), then by original node index for ties.
  const indexById = new Map(nodes.map((n, i) => [n.id, i]));
  const inputOrderById = computeInputOrder(nodes, edges);

  const columns = new Map<number, string[]>();
  for (const node of nodes) {
    const col = depth.get(node.id) ?? 0;
    const bucket = columns.get(col) ?? [];
    bucket.push(node.id);
    columns.set(col, bucket);
  }

  const positionById = new Map<string, { x: number; y: number }>();
  for (const [col, ids] of columns) {
    const sorted = [...ids].sort((a, b) => {
      const oa = inputOrderById.get(a);
      const ob = inputOrderById.get(b);
      if (oa != null && ob != null && oa !== ob) return oa - ob;
      if (oa != null && ob == null) return -1;
      if (oa == null && ob != null) return 1;
      return (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0);
    });
    sorted.forEach((id, row) => {
      positionById.set(id, {
        x: ORIGIN_X + col * COLUMN_GAP,
        y: ORIGIN_Y + row * ROW_GAP,
      });
    });
  }

  return nodes.map((n) => {
    const pos = positionById.get(n.id);
    return pos ? { ...n, position: pos } : n;
  });
}

/** Longest-path layering: depth(node) = max(depth(input)) + 1, roots at 0. */
function computeDepths(
  nodes: CanvasNode[],
  edges: Edge[],
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      incoming.get(e.target)!.push(e.source);
    }
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string): number => {
    const cached = depth.get(id);
    if (cached != null) return cached;
    // Cycle guard: the backend forbids cycles, but stay safe if a transient
    // edit produced one — treat the back-edge as depth 0.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const inputs = incoming.get(id) ?? [];
    const d = inputs.length
      ? Math.max(...inputs.map((src) => resolve(src) + 1))
      : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const n of nodes) resolve(n.id);
  return depth;
}

/**
 * For each target of an edge, capture the min incoming `order` so an adapter's
 * upstream inputs stack vertically in their context order within their column.
 */
function computeInputOrder(
  nodes: CanvasNode[],
  edges: Edge[],
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const order = new Map<string, number>();
  for (const e of edges) {
    if (!ids.has(e.source)) continue;
    const o = edgeOrder(e);
    const prev = order.get(e.source);
    if (prev == null || o < prev) order.set(e.source, o);
  }
  return order;
}
