/**
 * Backend API client. A thin typed wrapper over fetch against the FastAPI
 * server (docs/04 §5). Replaced by an OpenAPI-generated client in a later
 * milestone so the pydantic schemas become the single cross-stack source.
 */

export const BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8770";

const AUTH_TOKEN_KEY = "ai-drama.authToken";
export const AUTH_UNAUTHORIZED_EVENT = "ai-drama:unauthorized";

let authToken =
  typeof window === "undefined"
    ? null
    : window.localStorage.getItem(AUTH_TOKEN_KEY);

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function getStoredAuthToken() {
  return authToken;
}

export function setStoredAuthToken(token: string | null) {
  authToken = token;
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

export interface Project {
  id: number;
  uid: string;
  title: string;
  created_at: string;
}

export interface AuthSession {
  token: string;
  username: string;
  is_admin: boolean;
}

export interface UserAccount {
  id: number;
  username: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserUpdate {
  username?: string;
  password?: string;
  is_admin?: boolean;
  is_active?: boolean;
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

export interface CanvasNodeDTO {
  id: string;
  kind: NodeKind;
  name: string;
  ref_id: number | null;
  position: [number, number];
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
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  const resp = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
  if (resp.status === 401) {
    setStoredAuthToken(null);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
    }
    throw new AuthError("not authenticated");
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await resp.json()) as T;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  const resp = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
  if (resp.status === 401) {
    setStoredAuthToken(null);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
    }
    throw new AuthError("not authenticated");
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
  }
}

export const api = {
  // auth
  login: (body: { username: string; password: string }) =>
    request<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getSession: () => request<AuthSession>("/api/auth/session"),

  // admin users
  listUsers: () => request<UserAccount[]>("/api/admin/users"),
  createUser: (body: {
    username: string;
    password: string;
    is_admin: boolean;
    is_active?: boolean;
  }) =>
    request<UserAccount>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateUser: (userId: number, body: UserUpdate) =>
    request<UserAccount>(`/api/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteUser: (userId: number) =>
    requestVoid(`/api/admin/users/${userId}`, { method: "DELETE" }),

  // model catalog
  getSeedanceVideoSettings: () =>
    request<VideoGenSettings>("/api/model-catalog/seedance/video-settings"),

  // projects
  listProjects: () => request<Project[]>("/api/projects"),
  getProject: (projectUid: string) =>
    request<Project>(`/api/projects/${projectUid}`),
  createProject: (body: { title: string; secondary_password: string }) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteProject: (projectUid: string, secondaryPassword: string) =>
    requestVoid(`/api/projects/${projectUid}`, {
      method: "DELETE",
      body: JSON.stringify({ secondary_password: secondaryPassword }),
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
