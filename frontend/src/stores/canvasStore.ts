/**
 * Canvas store (docs/04 §4, docs/06 §4) — the single source of truth for the
 * EP workshop graph.
 *
 * Canvas node/edge state lives here (zustand), NOT inside CanvasWorkshop, for
 * two reasons: (1) docs/04 §4 mandates Zustand for canvas local state; (2) the
 * WebMCP tools (docs/06) are build-time-extracted top-level functions that
 * cannot touch React component state — they reach the canvas only through this
 * module-level store. The UI and the AI tools therefore share one graph, so a
 * tool call makes the canvas update live.
 *
 * The store exposes two faces:
 *  - React Flow plumbing (setNodes/onNodesChange/connect/addNode) so the
 *    component drops in where useNodesState/useEdgesState used to be.
 *  - Business commands (upsertNode / connectNodes / buildShotVideoGraph / run)
 *    — the stable "canvas command layer" both the UI and the WebMCP tools call.
 */
import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";

import {
  api,
  type CanvasGraphDTO,
  type GenerationChannel,
  type Job,
  type NodeKind,
  type VideoGenSettings,
} from "../api/client";
import {
  ADAPTER_INPUTS,
  canConnect,
  createGenerationStartPatch,
  dtoToFlow,
  edgeOrder,
  flowToDto,
  formatCanvasTimestamp,
  isAdapterKind,
  normalizeVideoDuration,
  normalizeVideoResolution,
  patchForGenerationError,
  patchForJob,
  patchNodes,
  TERMINAL_JOB_STATUSES,
  type CanvasNode,
  type NodeData,
} from "../canvas/graph";
import { layoutGraph } from "../canvas/layout";

type NodesUpdater = CanvasNode[] | ((nodes: CanvasNode[]) => CanvasNode[]);
type EdgesUpdater = Edge[] | ((edges: Edge[]) => Edge[]);

export type CommandResult<T = void> =
  | ({ ok: true } & (T extends void ? object : { value: T }))
  | { ok: false; error: string };

export type CanvasSummaryNode = {
  id: string;
  kind: NodeKind;
  name: string;
  hasText: boolean;
  hasImage: boolean;
  inputs: string[];
  jobStatus?: Job["status"];
};

export type ShotAssetRef = {
  assetId?: number;
  assetName?: string;
  order?: number;
};

export type BuildShotInput = {
  shotId: string;
  prompt: string;
  assetRefs?: ShotAssetRef[];
  duration?: number;
  resolution?: string;
  label?: string;
};

type CanvasState = {
  episodeId: number | null;
  videoSettings: VideoGenSettings | undefined;
  nodes: CanvasNode[];
  edges: Edge[];
  renderingNodeId: string | null;
  savedAt: string;
  nodeSeq: number;

  // --- context wiring (set by the workshop component) ---
  setContext: (ctx: {
    episodeId: number;
    videoSettings: VideoGenSettings | undefined;
  }) => void;
  reset: () => void;

  // --- React Flow plumbing ---
  setNodes: (updater: NodesUpdater) => void;
  setEdges: (updater: EdgesUpdater) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  /** Port-type-checked connect for the UI's onConnect (silently ignores bad). */
  connect: (conn: Connection) => void;
  /** Palette "add node": generates an id + cascade position (manual layout). */
  addNode: (kind: NodeKind, label: string) => string;
  reorderInput: (
    targetId: string,
    sourceId: string,
    targetSourceId: string,
  ) => void;
  patchNode: (id: string, patch: Partial<NodeData>) => void;

  // --- DTO / persistence ---
  loadFromDto: (graph: CanvasGraphDTO) => void;
  toDto: () => CanvasGraphDTO | null;
  persist: () => Promise<void>;

  // --- generation (shared by UI buttons + WebMCP run tools) ---
  runNode: (nodeId: string, channel: GenerationChannel) => Promise<Job>;

  // --- business commands (WebMCP tool layer, docs/06 §3) ---
  upsertTextNode: (input: {
    nodeId: string;
    text?: string;
    label?: string;
    refId?: number | null;
  }) => CommandResult;
  upsertImageNode: (input: {
    nodeId: string;
    label?: string;
    assetId?: number;
    imageUrl?: string;
    refId?: number | null;
  }) => CommandResult;
  upsertAdapterNode: (input: {
    nodeId: string;
    kind: Extract<NodeKind, "text_gen" | "image_gen" | "video_gen">;
    label?: string;
    duration?: number;
    resolution?: string;
  }) => CommandResult;
  connectNodes: (sourceId: string, targetId: string) => CommandResult;
  setVideoParams: (
    nodeId: string,
    params: { duration?: number; resolution?: string },
  ) => CommandResult;
  deleteNode: (nodeId: string) => CommandResult;
  buildShotVideoGraph: (input: BuildShotInput) => CommandResult<{
    textNodeId: string;
    imageNodeIds: string[];
    videoGenNodeId: string;
  }>;
  relayout: () => void;
  getSummary: () => CanvasSummaryNode[];
};

function resolveUpdater<T>(updater: T[] | ((v: T[]) => T[]), prev: T[]): T[] {
  return typeof updater === "function"
    ? (updater as (v: T[]) => T[])(prev)
    : updater;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  episodeId: null,
  videoSettings: undefined,
  nodes: [],
  edges: [],
  renderingNodeId: null,
  savedAt: "",
  nodeSeq: 0,

  setContext: ({ episodeId, videoSettings }) =>
    set({ episodeId, videoSettings }),

  reset: () =>
    set({ nodes: [], edges: [], renderingNodeId: null, savedAt: "", nodeSeq: 0 }),

  setNodes: (updater) =>
    set((s) => ({ nodes: resolveUpdater(updater, s.nodes) })),

  setEdges: (updater) =>
    set((s) => ({ edges: resolveUpdater(updater, s.edges) })),

  onNodesChange: (changes) =>
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes) as CanvasNode[],
    })),

  onEdgesChange: (changes) =>
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),

  connect: (conn) => {
    const { nodes, edges } = get();
    const src = nodes.find((n) => n.id === conn.source);
    const tgt = nodes.find((n) => n.id === conn.target);
    if (!src || !tgt) return;
    if (!canConnect(src.data.kind, tgt.data.kind)) return;
    const order = edges.filter((e) => e.target === conn.target).length + 1;
    set({ edges: addEdge({ ...conn, data: { order } }, edges) });
  },

  addNode: (kind, label) => {
    const { nodes, videoSettings, nodeSeq } = get();
    const { id, seq } = nextPaletteNodeId(kind, nodes, nodeSeq);
    const data: NodeData = {
      kind,
      label,
      refId: null,
      ...(kind === "video_gen"
        ? {
            videoDuration: videoSettings?.duration.default,
            videoResolution: videoSettings?.resolution.default,
          }
        : {}),
    };
    set({
      nodeSeq: seq,
      nodes: [
        ...nodes,
        {
          id,
          position: { x: 80 + nodes.length * 36, y: 70 + nodes.length * 28 },
          data,
          type: "canvasNode",
        },
      ],
    });
    return id;
  },

  reorderInput: (targetId, sourceId, targetSourceId) =>
    set((s) => {
      const inputEdges = s.edges
        .filter((e) => e.target === targetId)
        .sort((a, b) => edgeOrder(a) - edgeOrder(b));
      const sourceIndex = inputEdges.findIndex((e) => e.source === sourceId);
      const targetIndex = inputEdges.findIndex(
        (e) => e.source === targetSourceId,
      );
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return s;
      }
      const reordered = [...inputEdges];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      const orderByEdgeId = new Map(
        reordered.map((edge, orderIndex) => [edge.id, orderIndex + 1]),
      );
      return {
        edges: s.edges.map((edge) =>
          edge.target === targetId && orderByEdgeId.has(edge.id)
            ? {
                ...edge,
                data: {
                  ...(edge.data as Record<string, unknown> | undefined),
                  order: orderByEdgeId.get(edge.id),
                },
              }
            : edge,
        ),
      };
    }),

  patchNode: (id, patch) =>
    set((s) => ({ nodes: patchNodes(s.nodes, id, patch) })),

  loadFromDto: (graph) => {
    const { nodes, edges } = dtoToFlow(graph);
    set({ nodes, edges, nodeSeq: maxPaletteNodeSeq(nodes) });
  },

  toDto: () => {
    const { episodeId, nodes, edges, videoSettings } = get();
    if (episodeId == null) return null;
    return flowToDto(episodeId, nodes, edges, videoSettings);
  },

  persist: async () => {
    const { episodeId } = get();
    const dto = get().toDto();
    if (episodeId == null || !dto) throw new Error("canvas has no episode context");
    await api.saveCanvas(episodeId, dto);
    set({ savedAt: formatCanvasTimestamp() });
  },

  runNode: async (nodeId, channel) => {
    const { episodeId, nodes } = get();
    if (episodeId == null) throw new Error("canvas has no episode context");
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`node not found: ${nodeId}`);

    const submit = pickSubmit(node.data.kind);
    if (!submit) throw new Error(`node ${nodeId} is not an adapter node`);

    const startedAt = Date.now();
    const clearOnStart =
      node.data.kind === "video_gen"
        ? { clipPath: null, videoUrl: undefined }
        : node.data.kind === "image_gen"
          ? { imageUrl: undefined }
          : {};
    set((s) => ({
      renderingNodeId: nodeId,
      nodes: patchNodes(
        s.nodes,
        nodeId,
        createGenerationStartPatch(startedAt, clearOnStart),
      ),
    }));

    try {
      // save-before-submit (docs/06 §2.6): the backend resolves output_node_id
      // against the PERSISTED canvas, so the node must be saved first.
      await get().persist();
      let current = await submit(episodeId, nodeId, channel);
      set((s) => ({
        nodes: patchNodes(s.nodes, nodeId, patchForJob(current, startedAt)),
      }));
      while (!TERMINAL_JOB_STATUSES.includes(current.status)) {
        await wait(1000);
        current = await api.getJob(current.id);
        set((s) => ({
          nodes: patchNodes(s.nodes, nodeId, patchForJob(current, startedAt)),
        }));
      }
      await get().persist();
      return current;
    } catch (error) {
      set((s) => ({
        nodes: patchNodes(
          s.nodes,
          nodeId,
          patchForGenerationError(error, startedAt),
        ),
      }));
      await get().persist().catch(() => undefined);
      throw error;
    } finally {
      set((s) => ({
        renderingNodeId: s.renderingNodeId === nodeId ? null : s.renderingNodeId,
      }));
    }
  },

  // ----- business commands (WebMCP tool layer) -----

  upsertTextNode: ({ nodeId, text, label, refId }) => {
    if (!nodeId) return { ok: false, error: "nodeId is required" };
    set((s) => applyUpsert(s, nodeId, "text", (data) => ({
      ...data,
      ...(text !== undefined ? { text } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(refId !== undefined ? { refId } : {}),
    })));
    get().relayout();
    return { ok: true };
  },

  upsertImageNode: ({ nodeId, label, assetId, imageUrl, refId }) => {
    if (!nodeId) return { ok: false, error: "nodeId is required" };
    set((s) => applyUpsert(s, nodeId, "image", (data) => ({
      ...data,
      ...(label !== undefined ? { label } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(assetId !== undefined ? { refId: assetId } : {}),
      ...(refId !== undefined ? { refId } : {}),
    })));
    get().relayout();
    return { ok: true };
  },

  upsertAdapterNode: ({ nodeId, kind, label, duration, resolution }) => {
    if (!nodeId) return { ok: false, error: "nodeId is required" };
    if (!isAdapterKind(kind)) {
      return { ok: false, error: `${kind} is not an adapter node kind` };
    }
    const { videoSettings } = get();
    set((s) => applyUpsert(s, nodeId, kind, (data) => ({
      ...data,
      ...(label !== undefined ? { label } : {}),
      ...(kind === "video_gen"
        ? {
            videoDuration:
              duration != null && videoSettings
                ? normalizeVideoDuration(duration, videoSettings)
                : (data.videoDuration ?? videoSettings?.duration.default),
            videoResolution:
              resolution != null && videoSettings
                ? normalizeVideoResolution(resolution, videoSettings)
                : (data.videoResolution ?? videoSettings?.resolution.default),
          }
        : {}),
    })));
    get().relayout();
    return { ok: true };
  },

  connectNodes: (sourceId, targetId) => {
    const { nodes, edges } = get();
    const src = nodes.find((n) => n.id === sourceId);
    const tgt = nodes.find((n) => n.id === targetId);
    if (!src) return { ok: false, error: `source node not found: ${sourceId}` };
    if (!tgt) return { ok: false, error: `target node not found: ${targetId}` };
    if (!ADAPTER_INPUTS[tgt.data.kind]) {
      return {
        ok: false,
        error: `${targetId} (${tgt.data.kind}) is a data node and accepts no input`,
      };
    }
    if (!canConnect(src.data.kind, tgt.data.kind)) {
      return {
        ok: false,
        error: `incompatible: ${src.data.kind} output cannot feed ${tgt.data.kind}`,
      };
    }
    const existing = edges.find(
      (e) => e.source === sourceId && e.target === targetId,
    );
    if (existing) return { ok: true }; // idempotent
    const order = edges.filter((e) => e.target === targetId).length + 1;
    set({
      edges: addEdge(
        {
          id: `${sourceId}->${targetId}`,
          source: sourceId,
          target: targetId,
          data: { order },
        },
        edges,
      ),
    });
    get().relayout();
    return { ok: true };
  },

  setVideoParams: (nodeId, { duration, resolution }) => {
    const { nodes, videoSettings } = get();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, error: `node not found: ${nodeId}` };
    if (node.data.kind !== "video_gen") {
      return { ok: false, error: `${nodeId} is not a video_gen node` };
    }
    set((s) => ({
      nodes: patchNodes(s.nodes, nodeId, {
        ...(duration != null && videoSettings
          ? { videoDuration: normalizeVideoDuration(duration, videoSettings) }
          : {}),
        ...(resolution != null && videoSettings
          ? {
              videoResolution: normalizeVideoResolution(
                resolution,
                videoSettings,
              ),
            }
          : {}),
      }),
    }));
    return { ok: true };
  },

  deleteNode: (nodeId) => {
    const { nodes } = get();
    if (!nodes.some((n) => n.id === nodeId)) {
      return { ok: false, error: `node not found: ${nodeId}` };
    }
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== nodeId),
      edges: s.edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      ),
    }));
    get().relayout();
    return { ok: true };
  },

  buildShotVideoGraph: (input) => {
    const { shotId, prompt, assetRefs = [], duration, resolution, label } = input;
    if (!shotId) return { ok: false, error: "shotId is required" };
    if (!prompt?.trim()) {
      // video_gen needs a non-empty text input to render (docs/06 §3.1).
      return { ok: false, error: "prompt is required (video_gen needs text)" };
    }
    const { videoSettings } = get();

    const textNodeId = `${shotId}_text`;
    const videoGenNodeId = `${shotId}_video_gen`;
    const imageNodeIds: string[] = [];

    // text prompt node + video_gen node (idempotent upsert by stable id).
    set((s) => {
      let state = s;
      state = applyUpsert(state, textNodeId, "text", (data) => ({
        ...data,
        text: prompt,
        label: label ? `${label} · prompt` : "shot prompt",
      }));
      state = applyUpsert(state, videoGenNodeId, "video_gen", (data) => ({
        ...data,
        label: label ?? "video",
        videoDuration:
          duration != null && videoSettings
            ? normalizeVideoDuration(duration, videoSettings)
            : (data.videoDuration ?? videoSettings?.duration.default),
        videoResolution:
          resolution != null && videoSettings
            ? normalizeVideoResolution(resolution, videoSettings)
            : (data.videoResolution ?? videoSettings?.resolution.default),
      }));
      return state;
    });

    // Image nodes from asset refs, ordered.
    const orderedRefs = [...assetRefs].map((ref, i) => ({
      ...ref,
      order: ref.order ?? i + 1,
    }));
    for (const ref of orderedRefs) {
      const resolved = resolveAssetRef(ref);
      const imageNodeId = `${shotId}_img_${ref.order}`;
      imageNodeIds.push(imageNodeId);
      set((s) =>
        applyUpsert(s, imageNodeId, "image", (data) => ({
          ...data,
          label: resolved.label ?? data.label ?? "image",
          refId: resolved.refId ?? data.refId,
        })),
      );
    }

    // Wire edges: text -> video_gen (order 1), then each image -> video_gen.
    const connectText = get().connectNodes(textNodeId, videoGenNodeId);
    if (!connectText.ok) return connectText;
    for (const imageNodeId of imageNodeIds) {
      const r = get().connectNodes(imageNodeId, videoGenNodeId);
      if (!r.ok) return r;
    }

    get().relayout();
    return {
      ok: true,
      value: { textNodeId, imageNodeIds, videoGenNodeId },
    };
  },

  relayout: () => set((s) => ({ nodes: layoutGraph(s.nodes, s.edges) })),

  getSummary: () => {
    const { nodes, edges } = get();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      name: n.data.label,
      hasText: Boolean(n.data.text?.trim()),
      hasImage: Boolean(n.data.imageUrl || n.data.refId != null),
      inputs: edges
        .filter((e) => e.target === n.id)
        .sort((a, b) => edgeOrder(a) - edgeOrder(b))
        .map((e) => byId.get(e.source)?.id ?? e.source),
      jobStatus: n.data.jobStatus,
    }));
  },
}));

// ----- internal helpers -----

function pickSubmit(
  kind: NodeKind,
):
  | ((
      episodeId: number,
      outputNodeId: string,
      channel: GenerationChannel,
    ) => Promise<Job>)
  | null {
  switch (kind) {
    case "text_gen":
      return api.submitText;
    case "image_gen":
      return api.submitImage;
    case "video_gen":
      return api.submitVideo;
    default:
      return null;
  }
}

function resolveAssetRef(ref: ShotAssetRef): {
  refId: number | null;
  label?: string;
} {
  if (ref.assetId != null) {
    return { refId: ref.assetId, label: ref.assetName };
  }
  if (ref.assetName) {
    const match = findAssetByName(ref.assetName);
    if (match) return { refId: match.id, label: match.name };
    // Unresolved name: keep the label so the AI/user can bind it later.
    return { refId: null, label: ref.assetName };
  }
  return { refId: null };
}

/**
 * Asset lookup for name-based refs. The store does not own the asset list
 * (TanStack Query does), so the workshop publishes a snapshot here for tools to
 * resolve names against without threading it through every call.
 */
let assetSnapshot: { id: number; name: string }[] = [];

export function publishAssetSnapshot(assets: { id: number; name: string }[]) {
  assetSnapshot = assets;
}

function findAssetByName(name: string): { id: number; name: string } | undefined {
  const lower = name.trim().toLowerCase();
  return (
    assetSnapshot.find((a) => a.name.toLowerCase() === lower) ??
    assetSnapshot.find((a) => a.name.toLowerCase().includes(lower))
  );
}

function nextPaletteNodeId(
  kind: NodeKind,
  nodes: CanvasNode[],
  currentSeq: number,
): { id: string; seq: number } {
  const existingIds = new Set(nodes.map((node) => node.id));
  let seq = Math.max(currentSeq, maxPaletteNodeSeq(nodes)) + 1;
  let id = `${kind}-${seq}`;
  while (existingIds.has(id)) {
    seq += 1;
    id = `${kind}-${seq}`;
  }
  return { id, seq };
}

function maxPaletteNodeSeq(nodes: CanvasNode[]): number {
  return nodes.reduce((maxSeq, node) => {
    const match = /-(\d+)$/.exec(node.id);
    if (!match) return maxSeq;
    const seq = Number(match[1]);
    return Number.isFinite(seq) ? Math.max(maxSeq, seq) : maxSeq;
  }, 0);
}

/** Upsert a node by id into a state object, returning the new state. */
function applyUpsert(
  state: CanvasState,
  nodeId: string,
  kind: NodeKind,
  patch: (data: NodeData) => NodeData,
): CanvasState {
  const existing = state.nodes.find((n) => n.id === nodeId);
  if (existing) {
    if (existing.data.kind !== kind) return state; // kind change is not allowed
    return {
      ...state,
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: patch(n.data) } : n,
      ),
    };
  }
  const baseData: NodeData = { kind, label: "", refId: null };
  const node: CanvasNode = {
    id: nodeId,
    position: { x: 0, y: 0 }, // relayout() assigns the real position
    type: "canvasNode",
    data: patch(baseData),
  };
  return { ...state, nodes: [...state.nodes, node] };
}
