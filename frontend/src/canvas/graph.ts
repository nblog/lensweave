/**
 * Canvas graph core (docs/01 §2.3, docs/04 §3, docs/06 §4).
 *
 * Pure, framework-agnostic canvas logic shared by the React workshop UI, the
 * zustand canvas store, and the WebMCP tool layer. Keeping node/DTO types, the
 * port-type guardrail, and flow<->DTO conversion here makes them a single
 * source of truth instead of being trapped inside the component — the WebMCP
 * tools (docs/06) need the same rules the UI enforces.
 */
import type { Edge, Node } from "@xyflow/react";

import {
  formatTimestamp,
} from "../utils/datetime";
import type {
  CanvasGraphDTO,
  CanvasNodePositionDTO,
  Job,
  NodeKind,
  VideoGenSettings,
} from "../api/client";

export type NodeData = {
  kind: NodeKind;
  label: string;
  refId: number | null;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  clipPath?: string | null;
  videoDuration?: number;
  videoResolution?: string;
  jobId?: string;
  jobStatus?: Job["status"];
  jobError?: string | null;
  generatedAt?: string;
  generationStartedAt?: number;
  generationElapsedMs?: number;
};

export type CanvasNode = Node<NodeData, "canvasNode">;

export const TEXT_NODE_MIN_SIZE = { width: 260, height: 140 } as const;

export type InputSummary = {
  id: string;
  label: string;
  kind: NodeKind;
};

export type NodeRunState = Pick<
  NodeData,
  "jobStatus" | "generatedAt" | "generationStartedAt" | "generationElapsedMs"
>;

// Port type produced by each node kind, and inputs each adapter accepts —
// mirrors the backend enums (docs/01 §2.3, models/enums.py) so the frontend
// guardrail (and the WebMCP connect tool) match the final backend check.
export type PortType = "text" | "image" | "video";

export const NODE_OUTPUT: Record<NodeKind, PortType> = {
  text: "text",
  image: "image",
  video: "video",
  text_gen: "text",
  image_gen: "image",
  video_gen: "video",
};

export const ADAPTER_INPUTS: Partial<Record<NodeKind, PortType[]>> = {
  text_gen: ["text"],
  image_gen: ["text", "image"],
  video_gen: ["text", "image"],
};

export const TERMINAL_JOB_STATUSES: Job["status"][] = [
  "succeeded",
  "failed",
  "canceled",
];

export function isActiveJobStatus(
  status: Job["status"] | undefined,
): boolean {
  return status === "queued" || status === "running";
}

export function isAdapterKind(kind: NodeKind): boolean {
  return Boolean(ADAPTER_INPUTS[kind]);
}

/** True if `source`'s output type is accepted by `target`'s input ports. */
export function canConnect(sourceKind: NodeKind, targetKind: NodeKind): boolean {
  const accepts = ADAPTER_INPUTS[targetKind];
  if (!accepts) return false; // data nodes accept no input
  return accepts.includes(NODE_OUTPUT[sourceKind]);
}

// --- flow <-> dto conversion ---

export function flowToDto(
  episodeId: number,
  nodes: CanvasNode[],
  edges: Edge[],
  videoSettings?: VideoGenSettings,
): CanvasGraphDTO {
  return {
    episode_id: episodeId,
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      name: n.data.label,
      ref_id: n.data.refId,
      position: nodePositionToDto(n),
      data: nodeDataToPayload(n.data, videoSettings),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      order: (e.data as { order?: number })?.order ?? 0,
    })),
  };
}

export function dtoToFlow(graph: CanvasGraphDTO): {
  nodes: CanvasNode[];
  edges: Edge[];
} {
  return {
    nodes: graph.nodes.map((n) => {
      const position = readDtoPosition(n.position);
      const size =
        isTextLikeKind(n.kind) &&
        position.width != null &&
        position.height != null
          ? clampTextNodeSize({
              width: position.width,
              height: position.height,
            })
          : null;
      return {
        id: n.id,
        position: { x: position.x, y: position.y },
        type: "canvasNode",
        ...(size
          ? {
              width: size.width,
              height: size.height,
              style: { width: size.width, height: size.height },
            }
          : {}),
        data: {
          kind: n.kind,
          label: normalizeNodeLabel(n.name, n.kind),
          refId: n.ref_id,
          text: readString(n.data?.visual_prompt) ?? readString(n.data?.text),
          imageUrl: readString(n.data?.image_uri) ?? readString(n.data?.image_url),
          videoUrl: readString(n.data?.video_url),
          clipPath: readString(n.data?.clip_path) ?? null,
          videoDuration: readVideoDuration(n.data?.duration),
          videoResolution: readVideoResolution(n.data?.resolution),
          jobId: readString(n.data?.job_id),
          jobStatus: readJobStatus(n.data?.job_status),
          jobError: readString(n.data?.job_error) ?? null,
          generatedAt: readString(n.data?.generated_at),
          generationStartedAt: readNumber(n.data?.generation_started_at),
          generationElapsedMs: readNumber(n.data?.generation_elapsed_ms),
        },
      };
    }),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: { order: e.order },
    })),
  };
}

export function nodeDataToPayload(
  data: NodeData,
  videoSettings?: VideoGenSettings,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (data.text) {
    payload.visual_prompt = data.text;
    payload.text = data.text;
  }
  if (data.imageUrl) {
    payload.image_uri = data.imageUrl;
    payload.image_url = data.imageUrl;
  }
  if (data.videoUrl) payload.video_url = data.videoUrl;
  if (data.clipPath) payload.clip_path = data.clipPath;
  if (data.kind === "video_gen") {
    const duration = data.videoDuration ?? videoSettings?.duration.default;
    const resolution = data.videoResolution ?? videoSettings?.resolution.default;
    if (duration != null) payload.duration = duration;
    if (resolution) payload.resolution = resolution;
  }
  if (data.jobId) payload.job_id = data.jobId;
  if (data.jobStatus) payload.job_status = data.jobStatus;
  if (data.jobError) payload.job_error = data.jobError;
  if (data.generatedAt) payload.generated_at = data.generatedAt;
  if (typeof data.generationStartedAt === "number") {
    payload.generation_started_at = data.generationStartedAt;
  }
  if (typeof data.generationElapsedMs === "number") {
    payload.generation_elapsed_ms = data.generationElapsedMs;
  }
  return payload;
}

function nodePositionToDto(node: CanvasNode): CanvasNodePositionDTO {
  const position: CanvasNodePositionDTO = {
    x: node.position.x,
    y: node.position.y,
  };
  const size = storedNodeSize(node);
  if (size) {
    position.width = size.width;
    position.height = size.height;
  }
  return position;
}

function storedNodeSize(node: CanvasNode): { width: number; height: number } | null {
  if (!isTextLikeKind(node.data.kind)) {
    return null;
  }
  const style = node.style as { width?: unknown; height?: unknown } | undefined;
  const width = readNumber(style?.width);
  const height = readNumber(style?.height);
  if (width == null || height == null || width <= 0 || height <= 0) {
    return null;
  }
  return clampTextNodeSize({ width, height });
}

export function hasExplicitTextNodeSize(node: CanvasNode): boolean {
  return storedNodeSize(node) != null;
}

function isTextLikeKind(kind: NodeKind): boolean {
  return kind === "text" || kind === "text_gen";
}

// --- ordered inputs (docs/04 §3.2: order = context order) ---

export function buildOrderedInputsByNodeId(
  nodes: CanvasNode[],
  edges: Edge[],
): Record<string, InputSummary[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.reduce<Record<string, InputSummary[]>>((acc, node) => {
    if (!ADAPTER_INPUTS[node.data.kind]) return acc;
    acc[node.id] = edges
      .filter((e) => e.target === node.id)
      .sort((a, b) => edgeOrder(a) - edgeOrder(b))
      .map((e) => byId.get(e.source))
      .filter((source): source is CanvasNode => Boolean(source))
      .map((source) => ({
        id: source.id,
        label: source.data.label || source.data.kind,
        kind: source.data.kind,
      }));
    return acc;
  }, {});
}

export function hasVideoPromptInput(
  nodeId: string,
  nodes: CanvasNode[],
  edges: Edge[],
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges
    .filter((e) => e.target === nodeId)
    .some((edge) => {
      const source = byId.get(edge.source);
      return (
        source != null &&
        NODE_OUTPUT[source.data.kind] === "text" &&
        Boolean(source.data.text?.trim())
      );
    });
}

export function edgeOrder(edge: Edge): number {
  return (edge.data as { order?: number })?.order ?? 0;
}

// --- node data patch helpers (shared by UI generate flows + WebMCP run tools) ---

export function patchNodes(
  nodes: CanvasNode[],
  id: string,
  patch: Partial<NodeData>,
): CanvasNode[] {
  return nodes.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
  );
}

export function createGenerationStartPatch(
  startedAt: number,
  patch: Partial<NodeData> = {},
): Partial<NodeData> {
  return {
    ...patch,
    jobId: undefined,
    jobStatus: "queued",
    jobError: null,
    generatedAt: undefined,
    generationStartedAt: startedAt,
    generationElapsedMs: 0,
  };
}

export function patchForGenerationError(
  error: unknown,
  startedAt: number,
): Partial<NodeData> {
  return {
    jobStatus: "failed",
    jobError: error instanceof Error ? error.message : String(error),
    generatedAt: formatCanvasTimestamp(),
    generationStartedAt: undefined,
    generationElapsedMs: elapsedMsSince(startedAt),
  };
}

export function patchForJob(job: Job, startedAt?: number): Partial<NodeData> {
  const result = job.result ?? {};
  const isTerminal = TERMINAL_JOB_STATUSES.includes(job.status);
  const patch: Partial<NodeData> = {
    jobId: job.id,
    jobStatus: job.status,
    jobError: job.error,
  };
  if (typeof startedAt === "number") {
    patch.generationElapsedMs = elapsedMsSince(startedAt);
    patch.generationStartedAt = isTerminal ? undefined : startedAt;
  }
  if (isTerminal) {
    patch.generatedAt = formatCanvasTimestamp();
  }
  if (typeof result.text === "string") {
    patch.text = result.text;
  }
  const imageUri = readString(result.image_url) ?? readString(result.image_path);
  if (imageUri) {
    patch.imageUrl = imageUri;
  }
  patch.clipPath = readString(result.clip_path) ?? null;
  patch.videoUrl = readString(result.video_url);
  return patch;
}

// --- value coercion + formatting ---

export function normalizeNodeLabel(name: string, kind: NodeKind): string {
  if (name === "文生文" && kind === "text_gen") return "文本生成";
  if (name === "图生成" && kind === "image_gen") return "图像生成";
  return name || kind;
}

export function normalizeVideoDuration(
  value: string | number,
  settings: VideoGenSettings,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return settings.duration.default;
  const rounded = Math.round(parsed);
  return Math.min(settings.duration.max, Math.max(settings.duration.min, rounded));
}

export function normalizeVideoResolution(
  value: string,
  settings: VideoGenSettings,
): string {
  return settings.resolution.options.includes(value)
    ? value
    : settings.resolution.default;
}

export function readVideoDuration(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function readVideoResolution(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readJobStatus(value: unknown): Job["status"] | undefined {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return undefined;
}

function readDtoPosition(value: unknown): CanvasNodePositionDTO {
  if (Array.isArray(value) && value.length === 2) {
    const [x, y] = value;
    return {
      x: readNumber(x) ?? 0,
      y: readNumber(y) ?? 0,
    };
  }
  if (!value || typeof value !== "object") {
    return { x: 0, y: 0 };
  }
  const position = value as Record<string, unknown>;
  const width = readNumber(position.width);
  const height = readNumber(position.height);
  return {
    x: readNumber(position.x) ?? 0,
    y: readNumber(position.y) ?? 0,
    ...(width != null && height != null && width > 0 && height > 0
      ? { width, height }
      : {}),
  };
}

export function clampTextNodeSize(size: {
  width: number;
  height: number;
}): { width: number; height: number } {
  return {
    width: Math.max(TEXT_NODE_MIN_SIZE.width, size.width),
    height: Math.max(TEXT_NODE_MIN_SIZE.height, size.height),
  };
}

export function formatCanvasTimestamp(date = new Date()): string {
  return formatTimestamp(date);
}

export function elapsedMsSince(startedAt: number, nowMs = Date.now()): number {
  return Math.max(0, nowMs - startedAt);
}

export function currentRunElapsedMs(
  node: NodeRunState,
  nowMs = Date.now(),
): number | undefined {
  if (
    typeof node.generationStartedAt === "number" &&
    isActiveJobStatus(node.jobStatus)
  ) {
    return elapsedMsSince(node.generationStartedAt, nowMs);
  }
  return node.generationElapsedMs;
}
