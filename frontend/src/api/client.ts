/**
 * Backend API client. A thin typed wrapper over fetch against the FastAPI
 * server (docs/04 §5). Replaced by an OpenAPI-generated client in a later
 * milestone so the pydantic schemas become the single cross-stack source.
 */

export const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8770";

export interface Project {
  id: number;
  uid: string;
  title: string;
  created_at: string;
}

export type AssetKind = "character" | "prop" | "scene";
export type AssetScope = "global" | "fixed" | "temporary";

export interface Asset {
  id: number;
  project_id: number | null;
  episode_id: number | null;
  source_asset_id: number | null;
  scope: AssetScope;
  kind: AssetKind;
  name: string;
  description: string | null;
  spec: Record<string, unknown>;
  image_path: string | null;
  created_at: string;
}

export interface AssetUpdate {
  kind?: AssetKind;
  name?: string;
  description?: string | null;
  spec?: Record<string, unknown>;
  image_path?: string | null;
  source_asset_id?: number | null;
}

export interface Episode {
  id: number;
  project_id: number;
  episode_no: number;
  title: string;
}

export interface SegmentRow {
  id: number;
  episode_id: number;
  segment_id: number;
  duration_sec: number;
  spec: Record<string, unknown>;
  panel_path: string | null;
  clip_path: string | null;
}

export type NodeKind =
  | "text"
  | "image"
  | "video"
  | "text_gen"
  | "image_gen"
  | "video_gen";

export interface CanvasNodePositionDTO {
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
}

export interface CanvasNodeDTO {
  id: string;
  kind: NodeKind;
  name: string;
  ref_id: number | null;
  position: CanvasNodePositionDTO;
  data: Record<string, unknown>;
}

export interface CanvasEdgeDTO {
  id: string;
  source: string;
  target: string;
  order: number;
}

export interface CanvasGraphDTO {
  episode_id: number;
  nodes: CanvasNodeDTO[];
  edges: CanvasEdgeDTO[];
}

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type GenerationChannel = "mock" | "routin";

export interface JobResult {
  text?: string;
  model?: string | null;
  image_path?: string | null;
  image_url?: string | null;
  size_bytes?: number;
  raw_image_path?: string | null;
  raw_size_bytes?: number;
  compression?: {
    target_bytes: number;
    format: string;
    lossless: boolean;
    quality: number | null;
    scale: number;
  };
  response_id?: string | null;
  video_url?: string | null;
  clip_path?: string | null;
  [key: string]: unknown;
}

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  target_table: string;
  target_id: number;
  provider_task_id: string | null;
  result: JobResult | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface VideoDurationSettings {
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface VideoResolutionSettings {
  options: string[];
  default: string;
}

export interface VideoGenSettings {
  duration: VideoDurationSettings;
  resolution: VideoResolutionSettings;
}

export const DEFAULT_GENERATION_CHANNEL: GenerationChannel =
  import.meta.env.VITE_GENERATION_CHANNEL === "routin" ? "routin" : "mock";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await resp.json()) as T;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
}

export const api = {
  // model catalog
  getSeedanceVideoSettings: () =>
    request<VideoGenSettings>("/api/model-catalog/seedance/video-settings"),

  // projects
  listProjects: () => request<Project[]>("/api/projects"),
  getProject: (projectUid: string) =>
    request<Project>(`/api/projects/${projectUid}`),
  createProject: (title: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  // layered assets
  listGlobalAssets: (kind?: AssetKind) =>
    request<Asset[]>(`/api/assets${kind ? `?kind=${kind}` : ""}`),
  createGlobalAsset: (body: {
    kind: AssetKind;
    name: string;
    description?: string | null;
    spec?: Record<string, unknown>;
    image_path?: string | null;
    source_asset_id?: number | null;
  }) =>
    request<Asset>("/api/assets", {
      method: "POST",
      body: JSON.stringify({ ...body, scope: "global" }),
    }),
  updateGlobalAsset: (assetId: number, body: AssetUpdate) =>
    request<Asset>(`/api/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteGlobalAsset: (assetId: number) =>
    requestVoid(`/api/assets/${assetId}`, { method: "DELETE" }),
  listProjectAssets: (projectUid: string, kind?: AssetKind) =>
    request<Asset[]>(
      `/api/projects/${projectUid}/assets${kind ? `?kind=${kind}` : ""}`,
    ),
  createProjectAsset: (
    projectUid: string,
    body: {
      kind: AssetKind;
      name: string;
      description?: string | null;
      spec?: Record<string, unknown>;
      image_path?: string | null;
      scope?: AssetScope;
      episode_id?: number | null;
      source_asset_id?: number | null;
    },
  ) =>
    request<Asset>(`/api/projects/${projectUid}/assets`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteProjectAsset: (projectUid: string, assetId: number) =>
    requestVoid(`/api/projects/${projectUid}/assets/${assetId}`, {
      method: "DELETE",
    }),
  updateProjectAsset: (
    projectUid: string,
    assetId: number,
    body: AssetUpdate,
  ) =>
    request<Asset>(`/api/projects/${projectUid}/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  getProjectAsset: (projectUid: string, assetId: number) =>
    request<Asset>(`/api/projects/${projectUid}/assets/${assetId}`),
  listEpisodeAssets: (episodeId: number, kind?: AssetKind) =>
    request<Asset[]>(
      `/api/episodes/${episodeId}/assets${kind ? `?kind=${kind}` : ""}`,
    ),
  createEpisodeAsset: (
    episodeId: number,
    body: {
      kind: AssetKind;
      name: string;
      description?: string | null;
      spec?: Record<string, unknown>;
      image_path?: string | null;
      scope?: AssetScope;
      source_asset_id?: number | null;
    },
  ) =>
    request<Asset>(`/api/episodes/${episodeId}/assets`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateEpisodeAsset: (
    episodeId: number,
    assetId: number,
    body: AssetUpdate,
  ) =>
    request<Asset>(`/api/episodes/${episodeId}/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteEpisodeAsset: (episodeId: number, assetId: number) =>
    requestVoid(`/api/episodes/${episodeId}/assets/${assetId}`, {
      method: "DELETE",
    }),

  // episodes
  listEpisodes: (projectUid: string) =>
    request<Episode[]>(`/api/projects/${projectUid}/episodes`),
  createEpisode: (
    projectUid: string,
    body: { episode_no: number; title: string },
  ) =>
    request<Episode>(`/api/projects/${projectUid}/episodes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // storyboard / segments
  setStoryboard: (
    episodeId: number,
    storyboard: {
      episode_id: number;
      title: string;
      segments: { segment_id: number; duration_sec?: number; visual_prompt: string }[];
    },
  ) =>
    request<SegmentRow[]>(`/api/episodes/${episodeId}/storyboard`, {
      method: "PUT",
      body: JSON.stringify(storyboard),
    }),
  listSegments: (episodeId: number) =>
    request<SegmentRow[]>(`/api/episodes/${episodeId}/segments`),

  // canvas
  getCanvas: (episodeId: number) =>
    request<CanvasGraphDTO>(`/api/episodes/${episodeId}/canvas`),
  saveCanvas: (episodeId: number, graph: CanvasGraphDTO) =>
    request<{ status: string }>(`/api/episodes/${episodeId}/canvas`, {
      method: "PUT",
      body: JSON.stringify(graph),
    }),

  // generation jobs
  submitText: (
    episodeId: number,
    outputNodeId: string,
    channel: GenerationChannel = DEFAULT_GENERATION_CHANNEL,
  ) =>
    request<Job>(`/api/episodes/${episodeId}/text`, {
      method: "POST",
      body: JSON.stringify({ output_node_id: outputNodeId, channel }),
    }),
  submitImage: (
    episodeId: number,
    outputNodeId: string,
    channel: GenerationChannel = DEFAULT_GENERATION_CHANNEL,
  ) =>
    request<Job>(`/api/episodes/${episodeId}/image`, {
      method: "POST",
      body: JSON.stringify({ output_node_id: outputNodeId, channel }),
    }),
  submitVideo: (
    episodeId: number,
    outputNodeId: string,
    channel: GenerationChannel = DEFAULT_GENERATION_CHANNEL,
  ) =>
    request<Job>(`/api/episodes/${episodeId}/video`, {
      method: "POST",
      body: JSON.stringify({ output_node_id: outputNodeId, channel }),
    }),
  getJob: (jobId: string) => request<Job>(`/api/jobs/${jobId}`),
};
