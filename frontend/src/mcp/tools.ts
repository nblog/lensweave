/**
 * WebMCP tool layer (docs/06) — the stable "canvas command layer" exposed to
 * local AI clients via navigator.modelContext.
 *
 * IMPORTANT for schema extraction (docs/06 §2, §4): each tool is a top-level
 * exported async function with ONE object parameter and a JSDoc block. The
 * vite-plugin-webmcp-nexus reads these at build time to derive the JSON Schema
 * and injects __webmcpSchema. Keep params shallow (no generics, ≤3 levels) and
 * give every property a JSDoc description.
 *
 * Tools never touch React state directly — they reach the canvas through the
 * module-level zustand store (useCanvasStore), so calls update the live UI.
 */
import { api, type GenerationChannel } from "../api/client";
import {
  publishAssetSnapshot,
  useCanvasStore,
  type BuildShotInput,
  type CanvasSummaryNode,
} from "../stores/canvasStore";

const store = () => useCanvasStore.getState();

function requireEpisode(episodeId: number): string | null {
  const ctx = store().episodeId;
  if (ctx == null) {
    return "no workshop open — call drama_open_workshop first";
  }
  if (ctx !== episodeId) {
    return `episode mismatch: workshop is on episode ${ctx}, not ${episodeId}`;
  }
  return null;
}

/**
 * Navigate the app to an episode's workshop canvas. Only routes the page; does
 * not modify the canvas. Call this before other workshop tools.
 */
export async function drama_open_workshop(params: {
  /** project uid (Project.uid, not the numeric id) */
  projectUid: string;
  /** numeric episode id */
  episodeId: number;
}): Promise<{ ok: boolean; url: string }> {
  const url = `/projects/${params.projectUid}/episodes/${params.episodeId}/workshop`;
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return { ok: true, url };
}

/**
 * List visual assets visible to an episode (global + project fixed + this
 * episode's temporary), for choosing images by name/kind. Returns asset id,
 * name, kind and scope; use the id with drama_upsert_image_node.
 * @readonly
 */
export async function drama_list_assets(params: {
  /** numeric episode id */
  episodeId: number;
}): Promise<
  { id: number; name: string; kind: string; scope: string }[]
> {
  const assets = await api.listEpisodeAssets(params.episodeId);
  publishAssetSnapshot(assets.map((a) => ({ id: a.id, name: a.name })));
  return assets.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    scope: a.scope,
  }));
}

/**
 * Read the current canvas as a node/edge summary (id, kind, name, whether it
 * carries text/image, ordered input node ids, job status). Use it to inspect
 * what exists before editing.
 * @readonly
 */
export async function drama_get_canvas(params: {
  /** numeric episode id */
  episodeId: number;
}): Promise<{ episodeId: number; nodes: CanvasSummaryNode[] }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  return { episodeId: params.episodeId, nodes: store().getSummary() };
}

/**
 * Build a complete shot subgraph in one call: a text prompt node, optional
 * image nodes from asset references (in order), and a video_gen node, wired
 * text->video_gen then each image->video_gen, with automatic layout. Builds the
 * graph only — it does NOT render. Trigger rendering separately with
 * drama_run_video_node. Node ids are namespaced by shotId so re-running updates
 * the same nodes instead of duplicating them.
 */
export async function drama_build_shot_video_graph(params: {
  /** numeric episode id (the workshop must be open on it) */
  episodeId: number;
  /** stable id prefix for this shot's nodes, e.g. "ep01_s001" */
  shotId: string;
  /** full shot prompt; becomes the text node feeding video_gen */
  prompt: string;
  /** optional human label for the shot's nodes */
  label?: string;
  /** referenced assets, attached to video_gen in the given order */
  assetRefs?: Array<{
    /** known asset id (preferred); from drama_list_assets */
    assetId?: number;
    /** or resolve by asset name (mapped to a ref internally) */
    assetName?: string;
    /** 1-based context order; defaults to array position */
    order?: number;
  }>;
  /** video duration in seconds; defaults to the model catalog default */
  duration?: number;
  /** video aspect ratio, e.g. "9:16"; defaults to the catalog default */
  ratio?: string;
  /** video resolution, e.g. "720p"; defaults to the catalog default */
  resolution?: string;
}): Promise<{
  ok: boolean;
  textNodeId: string;
  imageNodeIds: string[];
  videoGenNodeId: string;
}> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  // Ensure name-based asset refs can resolve.
  if (params.assetRefs?.some((r) => r.assetName && r.assetId == null)) {
    await drama_list_assets({ episodeId: params.episodeId });
  }
  const input: BuildShotInput = {
    shotId: params.shotId,
    prompt: params.prompt,
    assetRefs: params.assetRefs,
    duration: params.duration,
    ratio: params.ratio,
    resolution: params.resolution,
    label: params.label,
  };
  const result = store().buildShotVideoGraph(input);
  if (!result.ok) throw new Error(result.error);
  return { ok: true, ...result.value };
}

/**
 * Persist the current canvas to the backend (PUT /canvas). Generation tools
 * save automatically before submitting, so call this only to checkpoint manual
 * edits.
 */
export async function drama_save_canvas(params: {
  /** numeric episode id */
  episodeId: number;
}): Promise<{ ok: boolean }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  await store().persist();
  return { ok: true };
}

/**
 * Render a video_gen node: saves the canvas, submits the video job and polls to
 * a terminal state. Defaults to the "mock" channel; pass channel "routin" to
 * use the real (paid, queued) provider.
 */
export async function drama_run_video_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** id of the video_gen node to render */
  nodeId: string;
  /** generation channel; "mock" (default) or "routin" (real provider) */
  channel?: GenerationChannel;
}): Promise<{
  jobId: string;
  status: string;
  clipPath?: string | null;
  videoUrl?: string | null;
  error?: string | null;
}> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const job = await store().runNode(params.nodeId, params.channel ?? "mock");
  return {
    jobId: job.id,
    status: job.status,
    clipPath: job.result?.clip_path ?? null,
    videoUrl: job.result?.video_url ?? null,
    error: job.error,
  };
}

/**
 * Get a generation job's current status and result.
 * @readonly
 */
export async function drama_get_job(params: {
  /** job id returned by a run tool */
  jobId: string;
}): Promise<{ id: string; status: string; error: string | null }> {
  const job = await api.getJob(params.jobId);
  return { id: job.id, status: job.status, error: job.error };
}

// ===== Phase 2: fine-grained editing (docs/06 §3.2) =====
// These let the AI correct a canvas incrementally instead of rebuilding it.
// Node ids are caller-controlled and stable, so every upsert is idempotent.

/**
 * Create or update a text node by stable id. Sets its text content and/or
 * label, or binds it to a storyboard segment via refId. Re-calling with the
 * same nodeId updates in place.
 */
export async function drama_upsert_text_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** stable node id, e.g. "ep01_s001_text" */
  nodeId: string;
  /** text content (e.g. a prompt or caption) */
  text?: string;
  /** human-readable node label */
  label?: string;
  /** segment id to bind (TextNode->Segment), or null to unbind */
  refId?: number | null;
}): Promise<{ ok: boolean; nodeId: string }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const r = store().upsertTextNode({
    nodeId: params.nodeId,
    text: params.text,
    label: params.label,
    refId: params.refId,
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true, nodeId: params.nodeId };
}

/**
 * Create or update an image node by stable id, binding it to a visible asset
 * (by assetId, or assetName resolved against the episode's assets) or to a
 * direct image url. Re-calling with the same nodeId updates in place.
 */
export async function drama_upsert_image_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** stable node id, e.g. "ep01_s001_img_1" */
  nodeId: string;
  /** human-readable node label */
  label?: string;
  /** asset id to reference (preferred); from drama_list_assets */
  assetId?: number;
  /** or resolve the asset by name (mapped to a ref internally) */
  assetName?: string;
  /** direct image url, when not referencing an asset */
  imageUrl?: string;
}): Promise<{ ok: boolean; nodeId: string; refId: number | null }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  let assetId = params.assetId;
  let label = params.label;
  if (assetId == null && params.assetName) {
    // Resolve name -> id so the node binds a real ref, not free text.
    const assets = await api.listEpisodeAssets(params.episodeId);
    publishAssetSnapshot(assets.map((a) => ({ id: a.id, name: a.name })));
    const lower = params.assetName.trim().toLowerCase();
    const match =
      assets.find((a) => a.name.toLowerCase() === lower) ??
      assets.find((a) => a.name.toLowerCase().includes(lower));
    if (match) {
      assetId = match.id;
      label = label ?? match.name;
    }
  }
  const r = store().upsertImageNode({
    nodeId: params.nodeId,
    label,
    assetId,
    imageUrl: params.imageUrl,
  });
  if (!r.ok) throw new Error(r.error);
  const node = store().nodes.find((n) => n.id === params.nodeId);
  return { ok: true, nodeId: params.nodeId, refId: node?.data.refId ?? null };
}

/**
 * Create or update an adapter (generation) node by stable id: text_gen,
 * image_gen or video_gen. For video_gen, optionally set duration/ratio/resolution.
 * Re-calling with the same nodeId updates in place.
 */
export async function drama_upsert_adapter_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** stable node id, e.g. "ep01_s001_video_gen" */
  nodeId: string;
  /** adapter kind */
  kind: "text_gen" | "image_gen" | "video_gen";
  /** human-readable node label */
  label?: string;
  /** video_gen only: duration in seconds */
  duration?: number;
  /** video_gen only: aspect ratio, e.g. "9:16" */
  ratio?: string;
  /** video_gen only: resolution, e.g. "720p" */
  resolution?: string;
}): Promise<{ ok: boolean; nodeId: string }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const r = store().upsertAdapterNode({
    nodeId: params.nodeId,
    kind: params.kind,
    label: params.label,
    duration: params.duration,
    ratio: params.ratio,
    resolution: params.resolution,
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true, nodeId: params.nodeId };
}

/**
 * Connect two nodes (source output -> target adapter input). Validates
 * port-type compatibility and appends the edge in context order. Returns an
 * error if the connection is illegal (e.g. target is a data node, or the types
 * do not match).
 */
export async function drama_connect_nodes(params: {
  /** numeric episode id */
  episodeId: number;
  /** source node id (provides the output) */
  sourceId: string;
  /** target adapter node id (receives the input) */
  targetId: string;
}): Promise<{ ok: boolean }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const r = store().connectNodes(params.sourceId, params.targetId);
  if (!r.ok) throw new Error(r.error);
  return { ok: true };
}

/**
 * Set a video_gen node's duration, ratio and/or resolution (validated against the
 * model catalog bounds).
 */
export async function drama_set_video_params(params: {
  /** numeric episode id */
  episodeId: number;
  /** video_gen node id */
  nodeId: string;
  /** duration in seconds */
  duration?: number;
  /** aspect ratio, e.g. "9:16" */
  ratio?: string;
  /** resolution, e.g. "720p" */
  resolution?: string;
}): Promise<{ ok: boolean }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const r = store().setVideoParams(params.nodeId, {
    duration: params.duration,
    ratio: params.ratio,
    resolution: params.resolution,
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true };
}

/**
 * Delete a node and its connected edges. Use this to correct mistakes rather
 * than leaving stray nodes on the canvas.
 */
export async function drama_delete_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** node id to delete */
  nodeId: string;
}): Promise<{ ok: boolean }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const r = store().deleteNode(params.nodeId);
  if (!r.ok) throw new Error(r.error);
  return { ok: true };
}

/**
 * Run a text_gen node: saves the canvas, submits the text job and polls to a
 * terminal state. Defaults to the "mock" channel; pass "routin" for the real
 * provider.
 */
export async function drama_run_text_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** id of the text_gen node to run */
  nodeId: string;
  /** generation channel; "mock" (default) or "routin" */
  channel?: GenerationChannel;
}): Promise<{ jobId: string; status: string; text?: string; error?: string | null }> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const job = await store().runNode(params.nodeId, params.channel ?? "mock");
  return {
    jobId: job.id,
    status: job.status,
    text: job.result?.text,
    error: job.error,
  };
}

/**
 * Run an image_gen node: saves the canvas, submits the image job and polls to a
 * terminal state. Defaults to the "mock" channel; pass "routin" for the real
 * provider.
 */
export async function drama_run_image_node(params: {
  /** numeric episode id */
  episodeId: number;
  /** id of the image_gen node to run */
  nodeId: string;
  /** generation channel; "mock" (default) or "routin" */
  channel?: GenerationChannel;
}): Promise<{
  jobId: string;
  status: string;
  imageUrl?: string | null;
  error?: string | null;
}> {
  const err = requireEpisode(params.episodeId);
  if (err) throw new Error(err);
  const job = await store().runNode(params.nodeId, params.channel ?? "mock");
  return {
    jobId: job.id,
    status: job.status,
    imageUrl: job.result?.image_url ?? job.result?.image_path ?? null,
    error: job.error,
  };
}
