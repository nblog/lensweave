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
  type CSSProperties,
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
  type GenerationChannel,
  type Job,
  type NodeKind,
  type SegmentRow,
} from "../api/client";
import {
  ADAPTER_INPUTS,
  buildOrderedInputsByNodeId,
  clampTextNodeSize,
  currentRunElapsedMs,
  hasExplicitTextNodeSize,
  hasVideoPromptInput,
  isActiveJobStatus,
  NODE_OUTPUT,
  normalizeVideoDuration,
  normalizeVideoResolution,
  patchNodes,
  TEXT_NODE_MIN_SIZE,
  type CanvasNode,
  type InputSummary,
  type NodeData,
  type NodeRunState,
  type PortType,
} from "../canvas/graph";
import {
  publishAssetSnapshot,
  useCanvasStore,
} from "../stores/canvasStore";
import { ImagePreviewFrame } from "../components/ImagePreviewFrame";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "../components/ImagePreviewDialog";
import { useConfirm } from "../components/confirm-context";

type RuntimeNodeData = NodeData & {
  assets: Asset[];
  segments: SegmentRow[];
  orderedInputs: InputSummary[];
  isRendering: boolean;
  nowMs: number;
  canRenderVideo: boolean;
  onPatchNode: (id: string, patch: Partial<NodeData>) => void;
  onResizeNode: (id: string, size: CanvasSize) => void;
  onUploadImage: (id: string, imageUri: string) => void;
  onPreviewImage: (src: string, title: string) => void;
  onAddImageAsset: (id: string) => void;
  onGenerateText: (id: string) => void;
  onGenerateImage: (id: string) => void;
  onRenderVideo: (id: string) => void;
};

type GeneratedAssetDialogState = {
  nodeId: string;
  imageUri: string;
  previewSrc: string;
  suggestedName: string;
};
type GeneratedAssetTarget = "project" | "global";
type ProjectGeneratedAssetScope = Extract<AssetScope, "fixed" | "temporary">;

const ASSET_KIND_OPTIONS: AssetKind[] = ["character", "prop", "scene"];
const GENERATION_CHANNEL_STORAGE_KEY = "ai-drama:generation-channel";
const nodeTypes: NodeTypes = { canvasNode: CanvasNodeCard };
type CanvasPosition = { x: number; y: number };
type CanvasSize = { width: number; height: number };
type InsertNodeSize = { width: number; height: number };
type FlowPositionProjector = {
  screenToFlowPosition: (position: CanvasPosition) => CanvasPosition;
};

const DEFAULT_INSERT_NODE_SIZE: InsertNodeSize = { ...TEXT_NODE_MIN_SIZE };
const TEXT_NODE_CHROME_SIZE: CanvasSize = { width: 27, height: 58 };
const INSERT_NODE_SIZES: Partial<Record<NodeKind, InsertNodeSize>> = {
  image: { width: 260, height: 245 },
  image_gen: { width: 260, height: 245 },
  video: { width: 260, height: 230 },
  video_gen: { width: 280, height: 280 },
};

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

  // Canvas node/edge state lives in the module-level store (docs/04 §4,
  // docs/06 §4) so the WebMCP tools and the UI share one graph.
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const storeConnect = useCanvasStore((s) => s.connect);
  const addNodeToStore = useCanvasStore((s) => s.addNode);
  const reorderInput = useCanvasStore((s) => s.reorderInput);
  const savedAt = useCanvasStore((s) => s.savedAt);
  const setContext = useCanvasStore((s) => s.setContext);
  const loadFromDto = useCanvasStore((s) => s.loadFromDto);
  const resetCanvas = useCanvasStore((s) => s.reset);
  const persist = useCanvasStore((s) => s.persist);
  const runNode = useCanvasStore((s) => s.runNode);

  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const flowRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<FlowPositionProjector | null>(null);

  // Publish episode + catalog context into the store so store actions (and the
  // WebMCP tools) have what they need.
  useEffect(() => {
    setContext({ episodeId, videoSettings: videoSettings.data });
  }, [episodeId, videoSettings.data, setContext]);

  // Publish an asset snapshot for the tools' name->id resolution (docs/06 §2.8).
  useEffect(() => {
    if (assets.data) {
      publishAssetSnapshot(
        assets.data.map((a) => ({ id: a.id, name: a.name })),
      );
    }
  }, [assets.data]);

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

  const hasActiveGeneration = useMemo(
    () => nodes.some((node) => isActiveJobStatus(node.data.jobStatus)),
    [nodes],
  );

  useEffect(() => {
    if (!hasActiveGeneration) return;
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveGeneration]);

  useEffect(() => {
    resetCanvas();
    void api.getCanvas(episodeId).then((graph) => {
      loadFromDto(graph);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId]);

  const patchNode = useCallback(
    (id: string, patch: Partial<NodeData>) => {
      updateNode(setNodes, id, patch);
    },
    [setNodes],
  );

  const patchNodeSize = useCallback(
    (id: string, size: CanvasSize) => {
      setNodes((ns) =>
        ns.map((node) => {
          if (node.id !== id) return node;
          const nextSize =
            node.data.kind === "text" || node.data.kind === "text_gen"
              ? clampTextNodeSize(size)
              : size;
          return {
            ...node,
            width: nextSize.width,
            height: nextSize.height,
            style: {
              ...node.style,
              width: nextSize.width,
              height: nextSize.height,
            },
          };
        }),
      );
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

  const paletteNodePosition = useCallback(
    (kind: NodeKind): CanvasPosition | undefined => {
      const flow = flowRef.current;
      const instance = flowInstanceRef.current;
      if (!flow || !instance) return undefined;

      const rect = flow.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return undefined;

      const center = instance.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      const size = INSERT_NODE_SIZES[kind] ?? DEFAULT_INSERT_NODE_SIZE;
      return {
        x: center.x - size.width / 2,
        y: center.y - size.height / 2,
      };
    },
    [],
  );

  const addNode = (kind: NodeKind, label: string) => {
    const id = addNodeToStore(kind, label, paletteNodePosition(kind));
    setSelectedId(id);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const selectedIsRendering = isActiveJobStatus(selected?.data.jobStatus);

  const orderedInputsByNodeId = useMemo(
    () => buildOrderedInputsByNodeId(nodes, edges),
    [nodes, edges],
  );

  const reorderOrderedInput = useCallback(
    (targetId: string, sourceId: string, targetSourceId: string) => {
      reorderInput(targetId, sourceId, targetSourceId);
    },
    [reorderInput],
  );

  const handleSave = async () => {
    await persist();
  };

  const handleGenerateText = useCallback(
    (nodeId: string) => {
      setElapsedNow(Date.now());
      void runNode(nodeId, generationChannel).catch(() => undefined);
    },
    [generationChannel, runNode],
  );

  const handleGenerateImage = useCallback(
    (nodeId: string) => {
      setElapsedNow(Date.now());
      void runNode(nodeId, generationChannel).catch(() => undefined);
    },
    [generationChannel, runNode],
  );

  const handleRenderVideo = useCallback(
    (nodeId: string) => {
      setElapsedNow(Date.now());
      void runNode(nodeId, generationChannel).catch(() => undefined);
    },
    [generationChannel, runNode],
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
          isRendering: isActiveJobStatus(n.data.jobStatus),
          nowMs: elapsedNow,
          canRenderVideo:
            n.data.kind === "video_gen" &&
            hasVideoPromptInput(n.id, nodes, edges),
          onPatchNode: patchNode,
          onResizeNode: patchNodeSize,
          onUploadImage: handleUploadImage,
          onPreviewImage: handlePreviewImage,
          onAddImageAsset: handleAddImageAsset,
          onGenerateText: handleGenerateText,
          onGenerateImage: handleGenerateImage,
          onRenderVideo: handleRenderVideo,
        } satisfies RuntimeNodeData,
        className: [
          "rf-node",
          `rf-${n.data.kind}`,
          hasExplicitTextNodeSize(n) ? "rf-explicit-size" : "",
        ]
          .filter(Boolean)
          .join(" "),
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
      patchNodeSize,
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
        <div className="flow" ref={flowRef}>
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
            onConnect={storeConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            onBeforeDelete={handleBeforeDelete}
            onNodesDelete={(deleted) => {
              if (deleted.some((node) => node.id === selectedId)) {
                setSelectedId(null);
              }
            }}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
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
                    <InputNodeTypeIcon kind={n.kind} t={t} />
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
                disabled={selectedIsRendering}
                onClick={() => handleGenerateText(selected.id)}
              >
                {selectedIsRendering
                  ? t("canvas.generating")
                  : t("canvas.generateText")}
              </button>
              <AdapterInspectorRunState node={selected.data} nowMs={elapsedNow} />
              {selected.data.text && (
                <pre className="text-preview inspector-text-preview">
                  {selected.data.text}
                </pre>
              )}
            </>
          )}

          {selected?.data.kind === "image_gen" && (
            <>
              <hr />
              <button
                className="primary block"
                disabled={selectedIsRendering}
                onClick={() => handleGenerateImage(selected.id)}
              >
                {selectedIsRendering
                  ? t("canvas.generating")
                  : t("canvas.generateImage")}
              </button>
              <AdapterInspectorRunState node={selected.data} nowMs={elapsedNow} />
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
                retryDisabled={selectedIsRendering}
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
                disabled={!selectedVideoCanRender || selectedIsRendering}
                onClick={() => handleRenderVideo(selected.id)}
              >
                {selectedIsRendering
                  ? t("canvas.rendering")
                  : t("canvas.render")}
              </button>
              {!selectedVideoCanRender && (
                <p className="muted small">{t("canvas.needVideoGen")}</p>
              )}
              <AdapterInspectorRunState
                node={selected.data}
                nowMs={elapsedNow}
                className="video-gen-run-meta"
              />
            </>
          )}

          {selected &&
            selected.data.jobStatus &&
            selected.data.kind !== "image_gen" &&
            selected.data.kind !== "text_gen" &&
            selected.data.kind !== "video_gen" && (
            <div className="job-box">
              <span>
                {t("canvas.jobStatus")}:{" "}
                <strong>{selected.data.jobStatus}</strong>
              </span>
              {selected.data.jobError && (
                <p className="error small">{selected.data.jobError}</p>
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

function CanvasNodeCard({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps) {
  const { t } = useTranslation();
  const node = data as RuntimeNodeData;
  const explicitWidth = useCanvasStore((s) =>
    textNodeStyleDimension(s.nodes, id, "width"),
  );
  const explicitHeight = useCanvasStore((s) =>
    textNodeStyleDimension(s.nodes, id, "height"),
  );
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [textNodeChrome, setTextNodeChrome] = useState<CanvasSize>(
    TEXT_NODE_CHROME_SIZE,
  );
  const kindLabel = t(`canvas.${nodeKindLabelKey(node.kind)}`);
  const isAdapter = Boolean(ADAPTER_INPUTS[node.kind]);
  const isTextLike = node.kind === "text" || node.kind === "text_gen";
  const isImageLike = node.kind === "image" || node.kind === "image_gen";
  const isVideoLike = node.kind === "video" || node.kind === "video_gen";
  const showKindBadge = canRenameNodeTitle(node.kind);
  const imagePreview = imagePreviewUrl(node, node.assets);
  const videoPreview = videoPreviewUrl(node);
  const explicitSize =
    explicitWidth != null && explicitHeight != null
      ? clampTextNodeSize({ width: explicitWidth, height: explicitHeight })
      : undefined;
  const textAreaStyle =
    explicitSize != null
      ? ({
          width: Math.max(0, explicitSize.width - textNodeChrome.width),
          height: Math.max(0, explicitSize.height - textNodeChrome.height),
        } satisfies CSSProperties)
      : undefined;

  useEffect(() => {
    const card = cardRef.current;
    const textarea = card?.querySelector<HTMLTextAreaElement>(".node-textarea");
    if (!card || !textarea) return;

    const cardRect = card.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const nextChrome = {
      width: Math.max(0, Math.round(cardRect.width - textareaRect.width)),
      height: Math.max(0, Math.round(cardRect.height - textareaRect.height)),
    };
    setTextNodeChrome((current) =>
      current.width === nextChrome.width && current.height === nextChrome.height
        ? current
        : nextChrome,
    );
  }, [isTextLike]);

  const onResizeNode = node.onResizeNode;
  const handleTextAreaSizeChange = useCallback(
    ({ width: textAreaWidth, height: textAreaHeight }: CanvasSize) => {
      onResizeNode(id, clampTextNodeSize({
        width: textAreaWidth + textNodeChrome.width,
        height: textAreaHeight + textNodeChrome.height,
      }));
    },
    [id, onResizeNode, textNodeChrome],
  );

  return (
    <div
      ref={cardRef}
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
            style={textAreaStyle}
            onChange={(value) => node.onPatchNode(id, { text: value })}
            onSizeChange={handleTextAreaSizeChange}
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
            previewTrigger="doubleClick"
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

function textNodeStyleDimension(
  nodes: CanvasNode[],
  id: string,
  dimension: "width" | "height",
): number | undefined {
  const node = nodes.find((n) => n.id === id);
  if (!node || (node.data.kind !== "text" && node.data.kind !== "text_gen")) {
    return undefined;
  }
  const style = node.style as { width?: unknown; height?: unknown } | undefined;
  const value = style?.[dimension];
  if (typeof value !== "number" || value <= 0) {
    return undefined;
  }
  return value;
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

function AdapterInspectorRunState({
  node,
  nowMs,
  className,
}: {
  node: NodeRunState & Pick<NodeData, "jobError">;
  nowMs: number;
  className?: string;
}) {
  if (!node.jobStatus && !node.jobError) {
    return null;
  }

  const metaClassName = ["inspector-run-meta", className]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {node.jobStatus && (
        <div className={metaClassName}>
          <NodeRunMeta node={node} nowMs={nowMs} />
        </div>
      )}
      {node.jobError && <p className="error small">{node.jobError}</p>}
    </>
  );
}

function ImeTextarea({
  value,
  onChange,
  className,
  rows,
  placeholder,
  style,
  onSizeChange,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  rows?: number;
  placeholder?: string;
  style?: CSSProperties;
  onSizeChange?: (size: CanvasSize) => void;
}) {
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);
  const didObserveSizeRef = useRef(false);
  const lastSizeRef = useRef<CanvasSize | null>(null);

  useEffect(() => {
    if (!isComposingRef.current) {
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !onSizeChange || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const borderBox = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;
      const width = Math.round(borderBox?.inlineSize ?? entry.contentRect.width);
      const height = Math.round(borderBox?.blockSize ?? entry.contentRect.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;

      const nextSize = { width, height };
      const lastSize = lastSizeRef.current;
      lastSizeRef.current = nextSize;
      if (!didObserveSizeRef.current) {
        didObserveSizeRef.current = true;
        return;
      }
      if (lastSize?.width === width && lastSize.height === height) return;

      onSizeChange(nextSize);
    });

    observer.observe(textarea);
    return () => observer.disconnect();
  }, [onSizeChange]);

  return (
    <textarea
      ref={textareaRef}
      className={className}
      rows={rows}
      value={draft}
      placeholder={placeholder}
      style={style}
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
        previewTrigger="doubleClick"
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

// --- media url helpers (UI-only) ---

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

function InputNodeTypeIcon({ kind, t }: { kind: NodeKind; t: Translate }) {
  const outputType = NODE_OUTPUT[kind];
  const label = t(`canvas.${inputNodeOutputLabelKey(outputType)}`);
  return (
    <span
      className={`input-node-type-icon input-node-type-icon-${outputType}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {inputNodeOutputIcon(outputType)}
    </span>
  );
}

function inputNodeOutputIcon(outputType: PortType) {
  switch (outputType) {
    case "text":
      return <Type size={14} strokeWidth={2.2} aria-hidden />;
    case "image":
      return <ImageIcon size={14} strokeWidth={2.2} aria-hidden />;
    case "video":
      return <Clapperboard size={14} strokeWidth={2.2} aria-hidden />;
  }
}

function inputNodeOutputLabelKey(outputType: PortType): string {
  switch (outputType) {
    case "text":
      return "nodeText";
    case "image":
      return "nodeImage";
    case "video":
      return "nodeVideo";
  }
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
