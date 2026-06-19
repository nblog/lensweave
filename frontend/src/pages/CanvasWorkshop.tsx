/**
 * EP workshop canvas (docs/04 §3, ADR-001 + ADR-006) — the core interaction.
 *
 * A generic compute-graph DAG on React Flow. Data nodes (text/image/video) carry
 * a value; adapter nodes (text/image/video gen) run a generation. Connection
 * legality is enforced client-side by port-type compatibility (the first
 * guardrail; the backend schema is the final one). Input order at an adapter
 * node = context order. "Render video" on a video_gen node submits the episode
 * canvas node, polls the job, and plays the clip on that node.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Archive,
  Boxes,
  Clapperboard,
  Globe2,
  Image as ImageIcon,
  Loader2,
  RotateCw,
  Save,
  Sparkles,
  Timer,
  Type,
  X,
} from "lucide-react";

import {
  api,
  BASE_URL,
  DEFAULT_GENERATION_CHANNEL,
  type Asset,
  type AssetKind,
  type AssetScope,
  type CanvasGraphDTO,
  type GenerationChannel,
  type Job,
  type NodeKind,
  type SegmentRow,
  type VideoGenSettings,
} from "../api/client";
import { ImagePreviewFrame } from "../components/ImagePreviewFrame";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "../components/ImagePreviewDialog";
import { useConfirm } from "../components/confirm-context";
import { formatTimestamp } from "../utils/datetime";

type NodeData = {
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

type InputSummary = {
  id: string;
  label: string;
  kind: NodeKind;
};

type RuntimeNodeData = NodeData & {
  assets: Asset[];
  segments: SegmentRow[];
  orderedInputs: InputSummary[];
  isRendering: boolean;
  nowMs: number;
  canRenderVideo: boolean;
  onPatchNode: (id: string, patch: Partial<NodeData>) => void;
  onUploadImage: (id: string, imageUri: string) => void;
  onPreviewImage: (src: string, title: string) => void;
  onAddImageAsset: (id: string) => void;
  onGenerateText: (id: string) => void;
  onGenerateImage: (id: string) => void;
  onRenderVideo: (id: string) => void;
};

type CanvasNode = Node<NodeData, "canvasNode">;
type NodeRunState = Pick<
  NodeData,
  "jobStatus" | "generatedAt" | "generationStartedAt" | "generationElapsedMs"
>;
type GeneratedAssetDialogState = {
  nodeId: string;
  imageUri: string;
  previewSrc: string;
  suggestedName: string;
};
type GeneratedAssetTarget = "project" | "global";
type ProjectGeneratedAssetScope = Extract<AssetScope, "fixed" | "temporary">;

// Port type produced by each node kind, and inputs each adapter accepts —
// mirrors the backend enums (docs/01 §2.3) so the frontend guardrail matches.
type PortType = "text" | "image" | "video";
const NODE_OUTPUT: Record<NodeKind, PortType> = {
  text: "text",
  image: "image",
  video: "video",
  text_gen: "text",
  image_gen: "image",
  video_gen: "video",
};
const ADAPTER_INPUTS: Partial<Record<NodeKind, PortType[]>> = {
  text_gen: ["text"],
  image_gen: ["text", "image"],
  video_gen: ["text", "image"],
};

const TERMINAL_JOB_STATUSES: Job["status"][] = [
  "succeeded",
  "failed",
  "canceled",
];
const ASSET_KIND_OPTIONS: AssetKind[] = ["character", "prop", "scene"];
const GENERATION_CHANNEL_STORAGE_KEY = "ai-drama:generation-channel";
const nodeTypes: NodeTypes = { canvasNode: CanvasNodeCard };

let idCounter = 0;
const nextId = (p: string) => `${p}-${++idCounter}`;

export function CanvasWorkshop({
  projectUid,
  episodeId,
}: {
  projectUid: string;
  episodeId: number;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const assets = useQuery({
    queryKey: ["episode-assets", projectUid, episodeId],
    queryFn: () => api.listEpisodeAssets(episodeId),
  });
  const videoSettings = useQuery({
    queryKey: ["modelCatalog", "seedance", "videoSettings"],
    queryFn: () => api.getSeedanceVideoSettings(),
  });
  const segments = useQuery({
    queryKey: ["segments", episodeId],
    queryFn: () => api.listSegments(episodeId),
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string>("");
  const [renderingNodeId, setRenderingNodeId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<ImagePreviewState | null>(
    null,
  );
  const [assetDialog, setAssetDialog] =
    useState<GeneratedAssetDialogState | null>(null);
  const [generationChannel, setGenerationChannel] = useState<GenerationChannel>(
    () => readStoredGenerationChannel(),
  );
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const draggedInputIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!previewImage) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewImage(null);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewImage]);

  useEffect(() => {
    storeGenerationChannel(generationChannel);
  }, [generationChannel]);

  useEffect(() => {
    if (!renderingNodeId) return;
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [renderingNodeId]);

  useEffect(() => {
    void api.getCanvas(episodeId).then((graph) => {
      const loaded = dtoToFlow(graph);
      if (loaded.nodes.length) {
        setNodes(loaded.nodes);
        setEdges(loaded.edges);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  const patchNode = useCallback(
    (id: string, patch: Partial<NodeData>) => {
      updateNode(setNodes, id, patch);
    },
    [setNodes],
  );

  const handleUploadImage = useCallback(
    (id: string, imageUri: string) => {
      updateNode(setNodes, id, {
        imageUrl: imageUri,
        jobStatus: undefined,
        jobError: null,
      });
    },
    [setNodes],
  );

  const handlePreviewImage = useCallback((src: string, title: string) => {
    setPreviewImage({ src, title });
  }, []);

  const handleAddImageAsset = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node?.data.imageUrl) return;
      setAssetDialog({
        nodeId: id,
        imageUri: node.data.imageUrl,
        previewSrc: imagePreviewUrl(node.data, assets.data ?? []) ?? node.data.imageUrl,
        suggestedName: node.data.label || t("canvas.nodeImageGen"),
      });
    },
    [assets.data, nodes, t],
  );

  const handleCreateGeneratedAsset = useCallback(
    async (body: {
      target: GeneratedAssetTarget;
      scope: ProjectGeneratedAssetScope;
      kind: AssetKind;
      name: string;
      description: string | null;
      spec: Record<string, unknown>;
      image_path: string;
    }) => {
      const spec = {
        ...body.spec,
        asset_scope: body.target === "global" ? "global" : body.scope,
      };
      if (body.target === "global") {
        await api.createGlobalAsset({
          kind: body.kind,
          name: body.name,
          description: body.description,
          spec,
          image_path: body.image_path,
        });
      } else if (body.scope === "temporary") {
        await api.createEpisodeAsset(episodeId, {
          kind: body.kind,
          name: body.name,
          description: body.description,
          spec,
          image_path: body.image_path,
          scope: "temporary",
        });
      } else {
        await api.createProjectAsset(projectUid, {
          kind: body.kind,
          name: body.name,
          description: body.description,
          spec,
          image_path: body.image_path,
          scope: "fixed",
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      await queryClient.invalidateQueries({ queryKey: ["episode-assets"] });
      setAssetDialog(null);
    },
    [episodeId, projectUid, queryClient],
  );

  // Confirm node deletions to avoid accidental loss (docs/04 §3.4); deleting an
  // edge alone is cheap and reversible, so it passes through without a prompt.
  const handleBeforeDelete = useCallback(
    async ({ nodes: toDelete }: { nodes: Node[]; edges: Edge[] }) => {
      if (toDelete.length === 0) return true;
      return confirm({
        title: t("confirm.deleteNodeTitle", { count: toDelete.length }),
        message: t("confirm.deleteNodeMessage"),
        confirmLabel: t("confirm.delete"),
        danger: true,
      });
    },
    [confirm, t],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      const src = nodes.find((n) => n.id === conn.source);
      const tgt = nodes.find((n) => n.id === conn.target);
      if (!src || !tgt) return;
      const accepts = ADAPTER_INPUTS[tgt.data.kind];
      if (!accepts) return; // data nodes accept no input
      if (!accepts.includes(NODE_OUTPUT[src.data.kind])) return; // type mismatch
      const order = edges.filter((e) => e.target === conn.target).length + 1;
      setEdges((eds) => addEdge({ ...conn, data: { order } }, eds));
    },
    [nodes, edges, setEdges],
  );

  const addNode = (kind: NodeKind, label: string) => {
    const id = nextId(kind);
    const data: NodeData = {
      kind,
      label,
      refId: null,
      ...(kind === "video_gen"
        ? {
            videoDuration: videoSettings.data?.duration.default,
            videoResolution: videoSettings.data?.resolution.default,
          }
        : {}),
    };
    setNodes((ns) => [
      ...ns,
      {
        id,
        position: { x: 80 + ns.length * 36, y: 70 + ns.length * 28 },
        data,
        type: "canvasNode",
      },
    ]);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const graphDto: CanvasGraphDTO = useMemo(
    () => flowToDto(episodeId, nodes, edges, videoSettings.data),
    [episodeId, nodes, edges, videoSettings.data],
  );

  const orderedInputsByNodeId = useMemo(
    () => buildOrderedInputsByNodeId(nodes, edges),
    [nodes, edges],
  );

  const reorderOrderedInput = useCallback(
    (targetId: string, sourceId: string, targetSourceId: string) => {
      setEdges((eds) => {
        const inputEdges = eds
          .filter((e) => e.target === targetId)
          .sort(
            (a, b) =>
              ((a.data as { order?: number })?.order ?? 0) -
              ((b.data as { order?: number })?.order ?? 0),
          );
        const sourceIndex = inputEdges.findIndex((e) => e.source === sourceId);
        const targetIndex = inputEdges.findIndex((e) => e.source === targetSourceId);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
          return eds;
        }
        const reordered = [...inputEdges];
        const [moved] = reordered.splice(sourceIndex, 1);
        const insertIndex = sourceIndex < targetIndex ? targetIndex : targetIndex;
        reordered.splice(insertIndex, 0, moved);
        const orderByEdgeId = new Map(
          reordered.map((edge, orderIndex) => [edge.id, orderIndex + 1]),
        );
        return eds.map((edge) =>
          edge.target === targetId && orderByEdgeId.has(edge.id)
            ? {
                ...edge,
                data: {
                  ...(edge.data as Record<string, unknown> | undefined),
                  order: orderByEdgeId.get(edge.id),
                },
              }
            : edge,
        );
      });
    },
    [setEdges],
  );

  const handleSave = async () => {
    await api.saveCanvas(episodeId, graphDto);
    setSavedAt(formatCanvasTimestamp());
  };

  const saveNodesSnapshot = useCallback(
    async (nextNodes: CanvasNode[]) => {
      await api.saveCanvas(
        episodeId,
        flowToDto(episodeId, nextNodes, edges, videoSettings.data),
      );
      setSavedAt(formatCanvasTimestamp());
    },
    [edges, episodeId, videoSettings.data],
  );

  const handleGenerateText = useCallback(
    async (nodeId: string) => {
      const startedAt = Date.now();
      setElapsedNow(startedAt);
      setRenderingNodeId(nodeId);
      let latestNodes = patchNodes(
        nodes,
        nodeId,
        createGenerationStartPatch(startedAt),
      );
      setNodes(latestNodes);

      try {
        await saveNodesSnapshot(latestNodes);
        let current = await api.submitText(episodeId, nodeId, generationChannel);
        latestNodes = patchNodes(latestNodes, nodeId, patchForJob(current, startedAt));
        setNodes(latestNodes);
        while (!TERMINAL_JOB_STATUSES.includes(current.status)) {
          await wait(1000);
          current = await api.getJob(current.id);
          latestNodes = patchNodes(
            latestNodes,
            nodeId,
            patchForJob(current, startedAt),
          );
          setNodes(latestNodes);
        }
        await saveNodesSnapshot(latestNodes);
      } catch (error) {
        latestNodes = patchNodes(
          latestNodes,
          nodeId,
          patchForGenerationError(error, startedAt),
        );
        setNodes(latestNodes);
        await saveNodesSnapshot(latestNodes).catch(() => undefined);
      } finally {
        setRenderingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [episodeId, generationChannel, nodes, saveNodesSnapshot, setNodes],
  );

  const handleGenerateImage = useCallback(
    async (nodeId: string) => {
      const startedAt = Date.now();
      setElapsedNow(startedAt);
      setRenderingNodeId(nodeId);
      let latestNodes = patchNodes(
        nodes,
        nodeId,
        createGenerationStartPatch(startedAt, { imageUrl: undefined }),
      );
      setNodes(latestNodes);

      try {
        await saveNodesSnapshot(latestNodes);
        let current = await api.submitImage(episodeId, nodeId, generationChannel);
        latestNodes = patchNodes(latestNodes, nodeId, patchForJob(current, startedAt));
        setNodes(latestNodes);
        while (!TERMINAL_JOB_STATUSES.includes(current.status)) {
          await wait(1000);
          current = await api.getJob(current.id);
          latestNodes = patchNodes(
            latestNodes,
            nodeId,
            patchForJob(current, startedAt),
          );
          setNodes(latestNodes);
        }
        await saveNodesSnapshot(latestNodes);
      } catch (error) {
        latestNodes = patchNodes(
          latestNodes,
          nodeId,
          patchForGenerationError(error, startedAt),
        );
        setNodes(latestNodes);
        await saveNodesSnapshot(latestNodes).catch(() => undefined);
      } finally {
        setRenderingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [episodeId, generationChannel, nodes, saveNodesSnapshot, setNodes],
  );

  const handleRenderVideo = useCallback(
    async (nodeId: string) => {
      const startedAt = Date.now();
      setElapsedNow(startedAt);
      setRenderingNodeId(nodeId);
      let latestNodes = patchNodes(
        nodes,
        nodeId,
        createGenerationStartPatch(startedAt, {
          clipPath: null,
          videoUrl: undefined,
        }),
      );
      setNodes(latestNodes);
      try {
        await saveNodesSnapshot(latestNodes);
        const submitted = await api.submitVideo(episodeId, nodeId, generationChannel);
        let current = submitted;
        latestNodes = patchNodes(latestNodes, nodeId, patchForJob(current, startedAt));
        setNodes(latestNodes);
        while (!TERMINAL_JOB_STATUSES.includes(current.status)) {
          await wait(1000);
          current = await api.getJob(submitted.id);
          latestNodes = patchNodes(
            latestNodes,
            nodeId,
            patchForJob(current, startedAt),
          );
          setNodes(latestNodes);
        }
        await saveNodesSnapshot(latestNodes);
      } catch (error) {
        latestNodes = patchNodes(
          latestNodes,
          nodeId,
          patchForGenerationError(error, startedAt),
        );
        setNodes(latestNodes);
        await saveNodesSnapshot(latestNodes).catch(() => undefined);
      } finally {
        setRenderingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [episodeId, generationChannel, nodes, saveNodesSnapshot, setNodes],
  );

  // Ordered inputs of the selected adapter node (for the inspector list).
  const orderedInputs = selected ? orderedInputsByNodeId[selected.id] ?? [] : [];
  const selectedVideoCanRender =
    selected?.data.kind === "video_gen" &&
    hasVideoPromptInput(selected.id, nodes, edges);
  const selectedImagePreview =
    selected &&
    (selected.data.kind === "image" || selected.data.kind === "image_gen")
      ? imagePreviewUrl(selected.data, assets.data ?? [])
      : undefined;

  const flowNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          assets: assets.data ?? [],
          segments: segments.data ?? [],
          orderedInputs: orderedInputsByNodeId[n.id] ?? [],
          isRendering: renderingNodeId === n.id,
          nowMs: elapsedNow,
          canRenderVideo:
            n.data.kind === "video_gen" &&
            hasVideoPromptInput(n.id, nodes, edges),
          onPatchNode: patchNode,
          onUploadImage: handleUploadImage,
          onPreviewImage: handlePreviewImage,
          onAddImageAsset: handleAddImageAsset,
          onGenerateText: handleGenerateText,
          onGenerateImage: handleGenerateImage,
          onRenderVideo: handleRenderVideo,
        } satisfies RuntimeNodeData,
        className: `rf-node rf-${n.data.kind}`,
      })),
    [
      assets.data,
      edges,
      handleGenerateText,
      handleRenderVideo,
      handleGenerateImage,
      handlePreviewImage,
      handleAddImageAsset,
      handleUploadImage,
      elapsedNow,
      nodes,
      orderedInputsByNodeId,
      patchNode,
      renderingNodeId,
      segments.data,
    ],
  );

  return (
    <div className="workshop">
      <div className="palette">
        <span className="palette-title">{t("canvas.palette")}</span>
        <label className="channel-picker">
          <span>{t("canvas.channel")}</span>
          <select
            value={generationChannel}
            onChange={(e) =>
              setGenerationChannel(e.target.value as GenerationChannel)
            }
          >
            <option value="mock">{t("canvas.channelMock")}</option>
            <option value="routin">{t("canvas.channelRoutin")}</option>
          </select>
        </label>
        <button onClick={() => addNode("text_gen", t("canvas.nodeTextGen"))}>
          <Sparkles size={15} aria-hidden />
          <Type size={15} aria-hidden />
          {t("canvas.nodeTextGen")}
        </button>
        <button onClick={() => addNode("image_gen", t("canvas.nodeImageGen"))}>
          <Sparkles size={15} aria-hidden />
          <ImageIcon size={15} aria-hidden />
          {t("canvas.nodeImageGen")}
        </button>
        <button onClick={() => addNode("video_gen", t("canvas.nodeVideoGen"))}>
          <Sparkles size={15} aria-hidden />
          <Clapperboard size={15} aria-hidden />
          {t("canvas.nodeVideoGen")}
        </button>
        <button onClick={() => addNode("text", t("canvas.nodeText"))}>
          <Type size={15} aria-hidden />
          {t("canvas.nodeText")}
        </button>
        <button onClick={() => addNode("image", t("canvas.nodeImage"))}>
          <ImageIcon size={15} aria-hidden />
          {t("canvas.nodeImage")}
        </button>
        <div className="palette-spacer" />
        <button className="primary" onClick={handleSave}>
          <Save size={15} aria-hidden />
          {t("canvas.save")}
        </button>
      </div>

      <p className="canvas-hint">{t("canvas.hint")}</p>

      <div className="canvas-area">
        <div className="flow">
          {/* Top-left status overlay: node count + last saved (no assets). */}
          <div className="canvas-status">
            <span>
              <Boxes size={14} aria-hidden />
              {t("canvas.nodeCount")}: {nodes.length}
            </span>
            <span>
              <Save size={14} aria-hidden />
              {t("canvas.lastSaved")}: {savedAt || t("canvas.never")}
            </span>
          </div>
          <ReactFlow
            nodes={flowNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            onBeforeDelete={handleBeforeDelete}
            onNodesDelete={(deleted) => {
              if (deleted.some((node) => node.id === selectedId)) {
                setSelectedId(null);
              }
            }}
            deleteKeyCode={["Delete", "Backspace"]}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            {/* Draggable global preview, bottom-right (docs/04 §3.5). */}
            <MiniMap pannable zoomable position="bottom-right" />
          </ReactFlow>
        </div>

        <aside className="inspector">
          <h4>{t("canvas.nodeEditor")}</h4>
          {!selected && <p className="muted">{t("canvas.nothingSelected")}</p>}

          {selected?.data.kind === "text" && (
            <TextNodeEditor
              key={selected.id}
              node={selected}
              segments={segments.data ?? []}
              onChange={(refId, text, label) =>
                updateNode(setNodes, selected.id, { refId, text, label })
              }
            />
          )}

          {selected?.data.kind === "image" && (
            <ImageNodeEditor
              key={selected.id}
              node={selected}
              assets={assets.data ?? []}
              onChange={(refId, label, imageUrl) =>
                updateNode(setNodes, selected.id, { refId, label, imageUrl })
              }
              onPreviewImage={handlePreviewImage}
            />
          )}

          {selected &&
            canRenameNodeTitle(selected.data.kind) &&
            selected.data.kind !== "text" &&
            selected.data.kind !== "image" && (
              <NodeTitleEditor
                key={`${selected.id}-title`}
                value={selected.data.label}
                placeholder={t(`canvas.${nodeKindLabelKey(selected.data.kind)}`)}
                onChange={(label) =>
                  updateNode(setNodes, selected.id, { label })
                }
              />
            )}

          {selected && ADAPTER_INPUTS[selected.data.kind] && (
            <div className="ordered-inputs">
              <label>{t("canvas.orderedInputs")}</label>
              <ol className="ordered-input-list">
                {orderedInputs.map((n) => (
                  <li
                    key={n.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const draggedId = draggedInputIdRef.current;
                      if (draggedId) {
                        reorderOrderedInput(selected.id, draggedId, n.id);
                      }
                      draggedInputIdRef.current = null;
                    }}
                  >
                    <span
                      className="drag-grip"
                      draggable
                      aria-label={t("canvas.orderedInputs")}
                      title={t("canvas.orderedInputs")}
                      onDragStart={(event) => {
                        draggedInputIdRef.current = n.id;
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        draggedInputIdRef.current = null;
                      }}
                    />
                    <span className="input-node-label">{n.label || n.kind}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {selected?.data.kind === "text_gen" && (
            <>
              <hr />
              <button
                className="primary block"
                disabled={renderingNodeId === selected.id}
                onClick={() => handleGenerateText(selected.id)}
              >
                {renderingNodeId === selected.id
                  ? t("canvas.generating")
                  : t("canvas.generateText")}
              </button>
            </>
          )}

          {selected?.data.kind === "image_gen" && (
            <>
              <hr />
              <button
                className="primary block"
                disabled={renderingNodeId === selected.id}
                onClick={() => handleGenerateImage(selected.id)}
              >
                {renderingNodeId === selected.id
                  ? t("canvas.generating")
                  : t("canvas.generateImage")}
              </button>
              {selected.data.jobStatus && (
                <div className="inspector-run-meta">
                  <NodeRunMeta node={selected.data} nowMs={elapsedNow} />
                </div>
              )}
              {selected.data.jobError && (
                <p className="error small">{selected.data.jobError}</p>
              )}
              <ImagePreviewFrame
                src={selectedImagePreview}
                alt={selected.data.label || t("canvas.nodeImageGen")}
                className="inspector-image-frame"
                onPreview={handlePreviewImage}
                previewTrigger="doubleClick"
                onFavorite={
                  selected.data.imageUrl
                    ? () => handleAddImageAsset(selected.id)
                    : undefined
                }
                onRetry={() => handleGenerateImage(selected.id)}
                retryDisabled={renderingNodeId === selected.id}
              />
            </>
          )}

          {selected?.data.kind === "video_gen" && (
            <>
              <hr />
              <div className="content-editor video-gen-settings">
                <label htmlFor={`video-duration-${selected.id}`}>
                  {t("canvas.videoDuration")}
                </label>
                <input
                  id={`video-duration-${selected.id}`}
                  type="number"
                  min={videoSettings.data?.duration.min}
                  max={videoSettings.data?.duration.max}
                  step={videoSettings.data?.duration.step}
                  value={
                    selected.data.videoDuration ??
                    videoSettings.data?.duration.default ??
                    ""
                  }
                  disabled={!videoSettings.data}
                  onChange={(e) =>
                    videoSettings.data &&
                    updateNode(setNodes, selected.id, {
                      videoDuration: normalizeVideoDuration(
                        e.target.value,
                        videoSettings.data,
                      ),
                    })
                  }
                />
                <label htmlFor={`video-resolution-${selected.id}`}>
                  {t("canvas.videoResolution")}
                </label>
                <select
                  id={`video-resolution-${selected.id}`}
                  value={
                    selected.data.videoResolution ??
                    videoSettings.data?.resolution.default ??
                    ""
                  }
                  disabled={!videoSettings.data}
                  onChange={(e) =>
                    videoSettings.data &&
                    updateNode(setNodes, selected.id, {
                      videoResolution: normalizeVideoResolution(
                        e.target.value,
                        videoSettings.data,
                      ),
                    })
                  }
                >
                  {(videoSettings.data?.resolution.options ?? []).map((resolution) => (
                    <option key={resolution} value={resolution}>
                      {resolution}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="primary block"
                disabled={!selectedVideoCanRender || renderingNodeId === selected.id}
                onClick={() => handleRenderVideo(selected.id)}
              >
                {renderingNodeId === selected.id
                  ? t("canvas.rendering")
                  : t("canvas.render")}
              </button>
              {!selectedVideoCanRender && (
                <p className="muted small">{t("canvas.needVideoGen")}</p>
              )}
              {selected.data.jobStatus && (
                <div className="inspector-run-meta video-gen-run-meta">
                  <NodeRunMeta node={selected.data} nowMs={elapsedNow} />
                </div>
              )}
              {selected.data.jobError && (
                <p className="error small">{selected.data.jobError}</p>
              )}
            </>
          )}

          {selected &&
            selected.data.jobStatus &&
            selected.data.kind !== "image_gen" &&
            selected.data.kind !== "video_gen" && (
            <div className="job-box">
              <span>
                {t("canvas.jobStatus")}:{" "}
                <strong>{selected.data.jobStatus}</strong>
              </span>
              {selected.data.jobError && (
                <p className="error small">{selected.data.jobError}</p>
              )}
              {selected.data.kind === "text_gen" && selected.data.text && (
                <pre className="text-preview">{selected.data.text}</pre>
              )}
              {selected.data.kind === "video" && videoPreviewUrl(selected.data) && (
                <video
                  className="clip"
                  src={videoPreviewUrl(selected.data)}
                  controls
                  autoPlay
                  loop
                />
              )}
            </div>
          )}
        </aside>
      </div>

      {previewImage && (
        <ImagePreviewDialog
          preview={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {assetDialog && (
        <GeneratedAssetDialog
          draft={assetDialog}
          onClose={() => setAssetDialog(null)}
          onSubmit={handleCreateGeneratedAsset}
        />
      )}
    </div>
  );
}

function CanvasNodeCard({ id, data, selected, isConnectable }: NodeProps) {
  const { t } = useTranslation();
  const node = data as RuntimeNodeData;
  const kindLabel = t(`canvas.${nodeKindLabelKey(node.kind)}`);
  const isAdapter = Boolean(ADAPTER_INPUTS[node.kind]);
  const isTextLike = node.kind === "text" || node.kind === "text_gen";
  const isImageLike = node.kind === "image" || node.kind === "image_gen";
  const isVideoLike = node.kind === "video" || node.kind === "video_gen";
  const showKindBadge = canRenameNodeTitle(node.kind);
  const imagePreview = imagePreviewUrl(node, node.assets);
  const videoPreview = videoPreviewUrl(node);

  return (
    <div
      className={`canvas-node canvas-node-${node.kind}${selected ? " selected" : ""}${
        node.isRendering ? " is-generating" : ""
      }`}
    >
      {isAdapter && (
        <Handle type="target" position={Position.Top} isConnectable={isConnectable} />
      )}
      <div className="canvas-node-header">
        <strong className="node-title-display">{node.label || kindLabel}</strong>
        {(showKindBadge || (node.label || kindLabel) !== kindLabel) && (
          <span>{kindLabel}</span>
        )}
      </div>

      {isTextLike && (
        <div className="node-text-wrap">
          <ImeTextarea
            className="node-textarea nodrag nowheel"
            rows={node.kind === "text_gen" ? 3 : 4}
            value={node.text ?? ""}
            placeholder={t("canvas.textValue")}
            onChange={(value) => node.onPatchNode(id, { text: value })}
          />
          {node.kind === "text_gen" && (
            <button
              className="node-retry node-text-retry nodrag"
              disabled={node.isRendering}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                node.onGenerateText(id);
              }}
              title={t("canvas.retry")}
              aria-label={t("canvas.retry")}
            >
              <RotateCw size={14} aria-hidden />
            </button>
          )}
        </div>
      )}

      {node.kind === "text" && node.segments.length > 0 && (
        <select
          className="node-select nodrag nowheel"
          value={node.refId ?? ""}
          onChange={(e) => {
            if (!e.target.value) {
              node.onPatchNode(id, { refId: null, label: kindLabel });
              return;
            }
            const sid = Number(e.target.value);
            const seg = node.segments.find((s) => s.id === sid);
            const text = (seg?.spec?.visual_prompt as string) ?? node.text ?? "";
            node.onPatchNode(id, {
              refId: sid,
              text,
              label: `seg#${seg?.segment_id ?? sid}`,
            });
          }}
        >
          <option value="">{t("canvas.noBinding")}</option>
          {node.segments.map((s) => (
            <option key={s.id} value={s.id}>
              #{s.segment_id} ({s.duration_sec}s)
            </option>
          ))}
        </select>
      )}

      {isImageLike && (
        <>
          <ImagePreviewFrame
            src={imagePreview}
            alt={node.label || t("canvas.nodeImage")}
            className="image-frame"
            onPreview={node.onPreviewImage}
            previewTrigger={node.kind === "image_gen" ? "doubleClick" : "button"}
            onUpload={
              node.kind === "image"
                ? (uri) => node.onUploadImage(id, uri)
                : undefined
            }
            onFavorite={
              node.kind === "image_gen" && node.imageUrl
                ? () => node.onAddImageAsset(id)
                : undefined
            }
            onRetry={
              node.kind === "image_gen"
                ? () => node.onGenerateImage(id)
                : undefined
            }
            retryDisabled={node.kind === "image_gen" && node.isRendering}
          />
          {node.kind === "image" && (
            <select
              className="node-select nodrag nowheel"
              value={node.refId ?? ""}
              onChange={(e) => {
                if (!e.target.value) {
                  node.onPatchNode(id, { refId: null, label: kindLabel });
                  return;
                }
                const aid = Number(e.target.value);
                const asset = node.assets.find((a) => a.id === aid);
                node.onPatchNode(id, {
                  refId: aid,
                  label: asset?.name ?? `asset#${aid}`,
                  imageUrl: asset?.image_path ?? node.imageUrl,
                });
              }}
            >
              <option value="">{t("canvas.noBinding")}</option>
              {node.assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name} ({asset.kind})
                </option>
              ))}
            </select>
          )}
        </>
      )}

      {isVideoLike && (
        <div className="node-media-frame video-frame">
          {videoPreview ? (
            <video src={videoPreview} controls loop />
          ) : (
            <span>{node.jobStatus ?? t("canvas.noPreview")}</span>
          )}
          {node.kind === "video_gen" && (
            <button
              className="node-retry nodrag"
              disabled={!node.canRenderVideo || node.isRendering}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                node.onRenderVideo(id);
              }}
              title={node.canRenderVideo ? t("canvas.retry") : t("canvas.needVideoGen")}
              aria-label={t("canvas.retry")}
            >
              <RotateCw size={14} aria-hidden />
            </button>
          )}
        </div>
      )}

      {node.isRendering && <NodeGenerationOverlay node={node} />}

      {node.jobStatus && <NodeRunMeta node={node} nowMs={node.nowMs} />}

      <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} />
    </div>
  );
}

function updateNode(
  setNodes: (updater: (ns: CanvasNode[]) => CanvasNode[]) => void,
  id: string,
  patch: Partial<NodeData>,
) {
  setNodes((ns) => patchNodes(ns, id, patch));
}

function patchNodes(
  nodes: CanvasNode[],
  id: string,
  patch: Partial<NodeData>,
): CanvasNode[] {
  return nodes.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
  );
}

function createGenerationStartPatch(
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

function patchForGenerationError(
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

function patchForJob(job: Job, startedAt?: number): Partial<NodeData> {
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

function NodeGenerationOverlay({ node }: { node: RuntimeNodeData }) {
  const { t } = useTranslation();
  const elapsedMs = currentRunElapsedMs(node, node.nowMs);

  return (
    <div className="node-generation-overlay" aria-live="polite">
      <div className="node-generation-content">
        <Loader2 className="node-generation-spinner" size={18} aria-hidden />
        <strong>{t("canvas.generating")}</strong>
        {elapsedMs != null && (
          <small>{t("canvas.elapsed", { time: formatElapsedDuration(elapsedMs) })}</small>
        )}
      </div>
    </div>
  );
}

function NodeRunMeta({
  node,
  nowMs,
}: {
  node: NodeRunState;
  nowMs?: number;
}) {
  const { t } = useTranslation();
  const elapsedMs = currentRunElapsedMs(node, nowMs);
  const statusLabel = node.jobStatus ? jobStatusLabel(node.jobStatus, t) : "";

  return (
    <div className="node-run-meta">
      {node.jobStatus && (
        <span
          className={`node-run-dot node-run-dot-${node.jobStatus}`}
          aria-hidden
        />
      )}
      {statusLabel && <span className="node-run-status">{statusLabel}</span>}
      {elapsedMs != null && (
        <span className="node-run-elapsed">
          <Timer size={12} aria-hidden />
          {t("canvas.elapsed", { time: formatElapsedDuration(elapsedMs) })}
        </span>
      )}
      {node.generatedAt && <time>{node.generatedAt}</time>}
    </div>
  );
}

function ImeTextarea({
  value,
  onChange,
  className,
  rows,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (!isComposingRef.current) {
      setDraft(value);
    }
  }, [value]);

  return (
    <textarea
      className={className}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onCompositionStart={() => {
        isComposingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        isComposingRef.current = false;
        const nextValue = event.currentTarget.value;
        setDraft(nextValue);
        onChange(nextValue);
      }}
      onChange={(event) => {
        const nextValue = event.currentTarget.value;
        setDraft(nextValue);
        if (!isComposingRef.current) {
          onChange(nextValue);
        }
      }}
      onBlur={() => {
        if (draft !== value) {
          onChange(draft);
        }
      }}
    />
  );
}

function NodeTitleEditor({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="content-editor node-title-editor">
      <label>{t("canvas.nodeTitle")}</label>
      <input
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function TextNodeEditor({
  node,
  segments,
  onChange,
}: {
  node: CanvasNode;
  segments: SegmentRow[];
  onChange: (refId: number | null, text: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const text = node.data.text ?? "";
  const refId = node.data.refId;

  return (
    <div className="content-editor">
      <label>{t("canvas.nodeTitle")}</label>
      <input
        value={node.data.label ?? ""}
        placeholder={t("canvas.nodeText")}
        onChange={(e) => onChange(refId, text, e.target.value)}
      />
      {segments.length > 0 && (
        <>
          <label>{t("canvas.pickSegment")}</label>
          <select
            value={refId ?? ""}
            onChange={(e) => {
              if (!e.target.value) {
                onChange(null, text, t("canvas.nodeText"));
                return;
              }
              const sid = Number(e.target.value);
              const seg = segments.find((s) => s.id === sid);
              const nextText = (seg?.spec?.visual_prompt as string) ?? text;
              onChange(sid, nextText, `seg#${seg?.segment_id ?? sid}`);
            }}
          >
            <option value="">{t("canvas.noBinding")}</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.segment_id} ({s.duration_sec}s)
              </option>
            ))}
          </select>
        </>
      )}
      <label>{t("canvas.textValue")}</label>
      <ImeTextarea
        rows={5}
        value={text}
        onChange={(value) => onChange(refId, value, node.data.label)}
      />
    </div>
  );
}

function ImageNodeEditor({
  node,
  assets,
  onChange,
  onPreviewImage,
}: {
  node: CanvasNode;
  assets: Asset[];
  onChange: (refId: number | null, label: string, imageUrl?: string) => void;
  onPreviewImage: (src: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const refId = node.data.refId;
  const preview = imagePreviewUrl(node.data, assets);
  return (
    <div className="content-editor">
      <label>{t("canvas.nodeTitle")}</label>
      <input
        value={node.data.label ?? ""}
        placeholder={t("canvas.nodeImage")}
        onChange={(e) => onChange(refId, e.target.value, node.data.imageUrl)}
      />
      <label>{t("canvas.pickAsset")}</label>
      <select
        value={refId ?? ""}
        onChange={(e) => {
          if (!e.target.value) {
            onChange(null, t("canvas.nodeImage"), node.data.imageUrl);
            return;
          }
          const aid = Number(e.target.value);
          const asset = assets.find((a) => a.id === aid);
          onChange(aid, asset?.name ?? `asset#${aid}`, asset?.image_path ?? undefined);
        }}
      >
        <option value="">{t("canvas.noBinding")}</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {t(`assets.scope${assetScopeLabelSuffix(readAssetScope(a))}`)} ·{" "}
            {t(`assets.kind${assetKindLabelSuffix(a.kind)}`)}
          </option>
        ))}
      </select>
      <label>{t("canvas.imagePreview")}</label>
      <ImagePreviewFrame
        src={preview}
        alt={node.data.label || t("canvas.nodeImage")}
        className="inspector-image-frame"
        onPreview={onPreviewImage}
        onUpload={(uri) => onChange(refId, node.data.label, uri)}
      />
    </div>
  );
}

function GeneratedAssetDialog({
  draft,
  onClose,
  onSubmit,
}: {
  draft: GeneratedAssetDialogState;
  onClose: () => void;
  onSubmit: (body: {
    target: GeneratedAssetTarget;
    scope: ProjectGeneratedAssetScope;
    kind: AssetKind;
    name: string;
    description: string | null;
    spec: Record<string, unknown>;
    image_path: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<GeneratedAssetTarget>("project");
  const [scope, setScope] = useState<ProjectGeneratedAssetScope>("fixed");
  const [kind, setKind] = useState<AssetKind>("character");
  const [name, setName] = useState(draft.suggestedName);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("assets.nameRequired"));
      return;
    }
    setIsSaving(true);
      setError(null);
    try {
      await onSubmit({
        target,
        scope,
        kind,
        name: trimmedName,
        description: description.trim() || null,
        spec: { asset_scope: target === "global" ? "global" : scope },
        image_path: draft.imageUri,
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : t("assets.saveError"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="asset-save-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={t("assets.addGeneratedTitle")}
    >
      <form className="asset-save-panel" onSubmit={handleSubmit}>
        <button
          className="asset-save-close"
          type="button"
          onClick={onClose}
          aria-label={t("confirm.cancel")}
          disabled={isSaving}
        >
          <X size={18} aria-hidden />
        </button>

        <div className="asset-save-preview">
          <img src={draft.previewSrc} alt={draft.suggestedName} />
        </div>

        <div className="asset-save-body">
          <span className="project-page-kicker">{t("assets.addFromGenerated")}</span>
          <h3>{t("assets.addGeneratedTitle")}</h3>
          <p>{t("assets.addGeneratedIntro")}</p>

          <label>{t("assets.assetTarget")}</label>
          <div className="asset-scope-options asset-target-options" role="group">
            <button
              type="button"
              className={
                target === "project"
                  ? "asset-scope-option active"
                  : "asset-scope-option"
              }
              onClick={() => setTarget("project")}
              disabled={isSaving}
            >
              <Boxes size={14} aria-hidden />
              {t("assets.targetProject")}
            </button>
            <button
              type="button"
              className={
                target === "global"
                  ? "asset-scope-option active"
                  : "asset-scope-option"
              }
              onClick={() => setTarget("global")}
              disabled={isSaving}
            >
              <Globe2 size={14} aria-hidden />
              {t("assets.targetGlobal")}
            </button>
          </div>

          {target === "project" && (
            <>
              <label>{t("assets.assetScope")}</label>
              <div className="asset-scope-options asset-target-options" role="group">
                <button
                  type="button"
                  className={
                    scope === "fixed"
                      ? "asset-scope-option active"
                      : "asset-scope-option"
                  }
                  onClick={() => setScope("fixed")}
                  disabled={isSaving}
                >
                  <Archive size={14} aria-hidden />
                  {t("assets.scopeFixed")}
                </button>
                <button
                  type="button"
                  className={
                    scope === "temporary"
                      ? "asset-scope-option active"
                      : "asset-scope-option"
                  }
                  onClick={() => setScope("temporary")}
                  disabled={isSaving}
                >
                  <Timer size={14} aria-hidden />
                  {t("assets.scopeTemporary")}
                </button>
              </div>
            </>
          )}

          <label htmlFor={`asset-kind-${draft.nodeId}`}>{t("assets.kind")}</label>
          <select
            id={`asset-kind-${draft.nodeId}`}
            value={kind}
            onChange={(event) => setKind(event.target.value as AssetKind)}
            disabled={isSaving}
          >
            {ASSET_KIND_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t(`assets.kind${assetKindLabelSuffix(option)}`)}
              </option>
            ))}
          </select>

          <label htmlFor={`asset-name-${draft.nodeId}`}>{t("assets.name")}</label>
          <input
            id={`asset-name-${draft.nodeId}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("assets.namePlaceholder")}
            disabled={isSaving}
            autoFocus
          />

          <label htmlFor={`asset-description-${draft.nodeId}`}>
            {t("assets.description")}
          </label>
          <textarea
            id={`asset-description-${draft.nodeId}`}
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("assets.descriptionPlaceholder")}
            disabled={isSaving}
          />

          {error && <p className="error small">{error}</p>}

          <div className="asset-save-actions">
            <button type="button" onClick={onClose} disabled={isSaving}>
              {t("confirm.cancel")}
            </button>
            <button className="primary" type="submit" disabled={isSaving}>
              {isSaving ? t("assets.saving") : t("assets.saveGenerated")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// --- flow <-> dto conversion ---

function flowToDto(
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
      position: [n.position.x, n.position.y],
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

function dtoToFlow(graph: CanvasGraphDTO): {
  nodes: CanvasNode[];
  edges: Edge[];
} {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      position: { x: n.position[0], y: n.position[1] },
      type: "canvasNode",
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
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: { order: e.order },
    })),
  };
}

function nodeDataToPayload(
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

function buildOrderedInputsByNodeId(
  nodes: CanvasNode[],
  edges: Edge[],
): Record<string, InputSummary[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.reduce<Record<string, InputSummary[]>>((acc, node) => {
    if (!ADAPTER_INPUTS[node.data.kind]) return acc;
    acc[node.id] = edges
      .filter((e) => e.target === node.id)
      .sort(
        (a, b) =>
          ((a.data as { order?: number })?.order ?? 0) -
          ((b.data as { order?: number })?.order ?? 0),
      )
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

function hasVideoPromptInput(
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

function imagePreviewUrl(data: NodeData, assets: Asset[] = []): string | undefined {
  if (data.imageUrl) return mediaUrl(data.imageUrl);
  if (data.refId == null) return undefined;
  const imagePath = assets.find((asset) => asset.id === data.refId)?.image_path;
  return imagePath ? mediaUrl(imagePath) : undefined;
}

function videoPreviewUrl(data: NodeData): string | undefined {
  if (data.clipPath) return clipUrl(data.clipPath);
  if (data.videoUrl) {
    return mediaUrl(data.videoUrl);
  }
  return undefined;
}

function clipUrl(clipPath: string): string {
  const name = clipPath.replace(/\\/g, "/").split("/").pop();
  return `${BASE_URL}/clips/${name}`;
}

function mediaUrl(uri: string): string {
  if (/^(https?:|data:|blob:)/.test(uri)) return uri;
  if (uri.startsWith("/")) return `${BASE_URL}${uri}`;
  return uri;
}

function formatCanvasTimestamp(date = new Date()): string {
  return formatTimestamp(date);
}

function elapsedMsSince(startedAt: number, nowMs = Date.now()): number {
  return Math.max(0, nowMs - startedAt);
}

function currentRunElapsedMs(
  node: NodeRunState,
  nowMs = Date.now(),
): number | undefined {
  if (
    typeof node.generationStartedAt === "number" &&
    (node.jobStatus === "queued" || node.jobStatus === "running")
  ) {
    return elapsedMsSince(node.generationStartedAt, nowMs);
  }
  return node.generationElapsedMs;
}

function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

type Translate = ReturnType<typeof useTranslation>["t"];

function jobStatusLabel(status: Job["status"], t: Translate): string {
  switch (status) {
    case "queued":
      return t("canvas.jobQueued");
    case "running":
      return t("canvas.jobRunning");
    case "succeeded":
      return t("canvas.jobSucceeded");
    case "failed":
      return t("canvas.jobFailed");
    case "canceled":
      return t("canvas.jobCanceled");
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nodeKindLabelKey(kind: NodeKind): string {
  switch (kind) {
    case "text":
      return "nodeText";
    case "image":
      return "nodeImage";
    case "video":
      return "nodeVideo";
    case "text_gen":
      return "nodeTextGen";
    case "image_gen":
      return "nodeImageGen";
    case "video_gen":
      return "nodeVideoGen";
  }
}

function canRenameNodeTitle(kind: NodeKind): boolean {
  return (
    kind === "text" ||
    kind === "image" ||
    kind === "video" ||
    kind === "text_gen" ||
    kind === "image_gen" ||
    kind === "video_gen"
  );
}

function normalizeNodeLabel(name: string, kind: NodeKind): string {
  if (name === "文生文" && kind === "text_gen") return "文本生成";
  if (name === "图生成" && kind === "image_gen") return "图像生成";
  return name || kind;
}

function assetKindLabelSuffix(kind: AssetKind): string {
  switch (kind) {
    case "character":
      return "Character";
    case "scene":
      return "Scene";
    case "prop":
      return "Prop";
  }
}

function assetScopeLabelSuffix(scope: AssetScope): string {
  switch (scope) {
    case "global":
      return "Global";
    case "fixed":
      return "Fixed";
    case "temporary":
      return "Temporary";
  }
}

function readAssetScope(asset: Asset): AssetScope {
  if (isAssetScope(asset.scope)) return asset.scope;
  if (asset.project_id == null) return "global";
  if (asset.episode_id != null) return "temporary";
  return "fixed";
}

function isAssetScope(value: unknown): value is AssetScope {
  return value === "global" || value === "fixed" || value === "temporary";
}

function normalizeVideoDuration(
  value: string | number,
  settings: VideoGenSettings,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return settings.duration.default;
  const rounded = Math.round(parsed);
  return Math.min(settings.duration.max, Math.max(settings.duration.min, rounded));
}

function readVideoDuration(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function normalizeVideoResolution(value: string, settings: VideoGenSettings): string {
  return settings.resolution.options.includes(value)
    ? value
    : settings.resolution.default;
}

function readVideoResolution(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readJobStatus(value: unknown): Job["status"] | undefined {
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

function readStoredGenerationChannel(): GenerationChannel {
  if (typeof window === "undefined") return DEFAULT_GENERATION_CHANNEL;
  try {
    const stored = window.localStorage.getItem(GENERATION_CHANNEL_STORAGE_KEY);
    return isGenerationChannel(stored) ? stored : DEFAULT_GENERATION_CHANNEL;
  } catch {
    return DEFAULT_GENERATION_CHANNEL;
  }
}

function storeGenerationChannel(channel: GenerationChannel): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GENERATION_CHANNEL_STORAGE_KEY, channel);
  } catch {
    // Local storage may be unavailable in restricted browser contexts.
  }
}

function isGenerationChannel(value: unknown): value is GenerationChannel {
  return value === "mock" || value === "routin";
}
