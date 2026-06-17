/**
 * EP workshop canvas (docs/04 §3, ADR-001 + ADR-006) — the core interaction.
 *
 * A generic compute-graph DAG on React Flow. Data nodes (text/image/video) carry
 * a value; adapter nodes (text/image/video gen) run a generation. Connection
 * legality is enforced client-side by port-type compatibility (the first
 * guardrail; the backend schema is the final one). Input order at an adapter
 * node = context order. "Render video" on a video_gen node submits the bound
 * segment, polls the job, and plays the clip on that node.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Boxes,
  Clapperboard,
  Image as ImageIcon,
  RotateCw,
  Save,
  Sparkles,
  Type,
} from "lucide-react";

import {
  api,
  BASE_URL,
  DEFAULT_GENERATION_CHANNEL,
  type Asset,
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
  canRenderVideo: boolean;
  onPatchNode: (id: string, patch: Partial<NodeData>) => void;
  onUploadImage: (id: string, imageUri: string) => void;
  onPreviewImage: (src: string, title: string) => void;
  onGenerateText: (id: string) => void;
  onGenerateImage: (id: string) => void;
  onRenderVideo: (id: string) => void;
};

type CanvasNode = Node<NodeData, "canvasNode">;
type NodeRunState = Pick<NodeData, "jobStatus" | "generatedAt">;

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
const nodeTypes: NodeTypes = { canvasNode: CanvasNodeCard };

let idCounter = 0;
const nextId = (p: string) => `${p}-${++idCounter}`;

export function CanvasWorkshop({
  projectId,
  episodeId,
}: {
  projectId: number;
  episodeId: number;
}) {
  void projectId;
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();

  const assets = useQuery({ queryKey: ["assets"], queryFn: () => api.listAssets() });
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
  const [generationChannel, setGenerationChannel] = useState<GenerationChannel>(
    DEFAULT_GENERATION_CHANNEL,
  );
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

  const seedStoryboard = async () => {
    await api.setStoryboard(episodeId, {
      episode_id: episodeId,
      title: `EP${episodeId}`,
      total_duration_sec: 6,
      segments: [
        {
          segment_id: 1,
          duration_sec: 6,
          visual_prompt:
            "极慢推进，中景到近景；女主立于前院大门内侧，指尖捏紧衣角，瞳孔骤缩——画面无字幕。",
        },
      ],
    });
    void qc.invalidateQueries({ queryKey: ["segments", episodeId] });
  };

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

  const handleGenerateText = useCallback(
    async (nodeId: string) => {
      await api.saveCanvas(
        episodeId,
        flowToDto(episodeId, nodes, edges, videoSettings.data),
      );
      setSavedAt(formatCanvasTimestamp());
      setRenderingNodeId(nodeId);
      updateNode(setNodes, nodeId, {
        jobId: undefined,
        jobStatus: "queued",
        jobError: null,
        generatedAt: undefined,
      });

      try {
        const job = await api.submitText(episodeId, nodeId, generationChannel);
        const patch = patchForJob(job);
        const nextNodes = patchNodes(nodes, nodeId, patch);
        setNodes(nextNodes);
        await api.saveCanvas(
          episodeId,
          flowToDto(episodeId, nextNodes, edges, videoSettings.data),
        );
        setSavedAt(formatCanvasTimestamp());
      } catch (error) {
        updateNode(setNodes, nodeId, {
          jobStatus: "failed",
          jobError: error instanceof Error ? error.message : String(error),
          generatedAt: formatCanvasTimestamp(),
        });
      } finally {
        setRenderingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [edges, episodeId, generationChannel, nodes, setNodes, videoSettings.data],
  );

  const handleGenerateImage = useCallback(
    async (nodeId: string) => {
      await api.saveCanvas(
        episodeId,
        flowToDto(episodeId, nodes, edges, videoSettings.data),
      );
      setSavedAt(formatCanvasTimestamp());
      setRenderingNodeId(nodeId);
      updateNode(setNodes, nodeId, {
        jobId: undefined,
        jobStatus: "queued",
        jobError: null,
        imageUrl: undefined,
        generatedAt: undefined,
      });

      try {
        const job = await api.submitImage(episodeId, nodeId, generationChannel);
        const patch = patchForJob(job);
        const nextNodes = patchNodes(nodes, nodeId, patch);
        setNodes(nextNodes);
        await api.saveCanvas(
          episodeId,
          flowToDto(episodeId, nextNodes, edges, videoSettings.data),
        );
        setSavedAt(formatCanvasTimestamp());
      } catch (error) {
        updateNode(setNodes, nodeId, {
          jobStatus: "failed",
          jobError: error instanceof Error ? error.message : String(error),
          generatedAt: formatCanvasTimestamp(),
        });
      } finally {
        setRenderingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [edges, episodeId, generationChannel, nodes, setNodes, videoSettings.data],
  );

  const handleRenderVideo = useCallback(
    async (nodeId: string) => {
      const segmentId = findVideoTargetSegmentId(
        nodeId,
        nodes,
        edges,
        segments.data ?? [],
      );
      if (segmentId == null) return;

      await api.saveCanvas(
        episodeId,
        flowToDto(episodeId, nodes, edges, videoSettings.data),
      );
      setSavedAt(formatCanvasTimestamp());
      setRenderingNodeId(nodeId);
      updateNode(setNodes, nodeId, {
        jobId: undefined,
        jobStatus: "queued",
        jobError: null,
        clipPath: null,
        videoUrl: undefined,
        generatedAt: undefined,
      });

      let latestNodes = patchNodes(nodes, nodeId, {
        jobStatus: "queued",
        jobError: null,
      });
      try {
        const submitted = await api.submitVideo(
          segmentId,
          nodeId,
          generationChannel,
        );
        let current = submitted;
        latestNodes = patchNodes(latestNodes, nodeId, patchForJob(current));
        setNodes(latestNodes);
        while (!TERMINAL_JOB_STATUSES.includes(current.status)) {
          await new Promise((r) => setTimeout(r, 1000));
          current = await api.getJob(submitted.id);
          latestNodes = patchNodes(latestNodes, nodeId, patchForJob(current));
          setNodes(latestNodes);
        }
        await api.saveCanvas(
          episodeId,
          flowToDto(episodeId, latestNodes, edges, videoSettings.data),
        );
        setSavedAt(formatCanvasTimestamp());
      } catch (error) {
        updateNode(setNodes, nodeId, {
          jobStatus: "failed",
          jobError: error instanceof Error ? error.message : String(error),
          generatedAt: formatCanvasTimestamp(),
        });
      } finally {
        setRenderingNodeId((current) => (current === nodeId ? null : current));
      }
    },
    [
      edges,
      episodeId,
      generationChannel,
      nodes,
      segments.data,
      setNodes,
      videoSettings.data,
    ],
  );

  // Ordered inputs of the selected adapter node (for the inspector list).
  const orderedInputs = selected ? orderedInputsByNodeId[selected.id] ?? [] : [];
  const selectedVideoSegmentId =
    selected?.data.kind === "video_gen"
      ? findVideoTargetSegmentId(
          selected.id,
          nodes,
          edges,
          segments.data ?? [],
        )
      : null;
  const selectedVideoCanRender =
    selected?.data.kind === "video_gen" &&
    selectedVideoSegmentId != null &&
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
          canRenderVideo:
            n.data.kind === "video_gen" &&
            findVideoTargetSegmentId(
              n.id,
              nodes,
              edges,
              segments.data ?? [],
            ) != null &&
            hasVideoPromptInput(n.id, nodes, edges),
          onPatchNode: patchNode,
          onUploadImage: handleUploadImage,
          onPreviewImage: handlePreviewImage,
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
      handleUploadImage,
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
        {segments.data && segments.data.length === 0 && (
          <button onClick={seedStoryboard}>{t("canvas.seedStoryboard")}</button>
        )}
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
                  <NodeRunMeta node={selected.data} />
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
                onRetry={() => handleGenerateImage(selected.id)}
                retryDisabled={renderingNodeId === selected.id}
              />
            </>
          )}

          {selected?.data.kind === "video_gen" && (
            <>
              <hr />
              {segments.data && segments.data.length > 1 && (
                <div className="content-editor">
                  <label>{t("canvas.targetSegment")}</label>
                  <select
                    value={selected.data.refId ?? ""}
                    onChange={(e) =>
                      updateNode(setNodes, selected.id, {
                        refId: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  >
                    <option value="">{t("canvas.autoTargetSegment")}</option>
                    {segments.data.map((s) => (
                      <option key={s.id} value={s.id}>
                        #{s.segment_id} ({s.duration_sec}s)
                      </option>
                    ))}
                  </select>
                </div>
              )}
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
                  <NodeRunMeta node={selected.data} />
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
  const hasEditableTitle = canRenameNodeTitle(node.kind);
  const imagePreview = imagePreviewUrl(node, node.assets);
  const videoPreview = videoPreviewUrl(node);

  return (
    <div
      className={`canvas-node canvas-node-${node.kind}${selected ? " selected" : ""}`}
    >
      {isAdapter && (
        <Handle type="target" position={Position.Top} isConnectable={isConnectable} />
      )}
      <div className="canvas-node-header">
        {hasEditableTitle ? (
          <input
            className="node-title-input nodrag nowheel"
            value={node.label ?? ""}
            placeholder={kindLabel}
            onChange={(e) => node.onPatchNode(id, { label: e.target.value })}
          />
        ) : (
          <strong>{node.label || kindLabel}</strong>
        )}
        {(hasEditableTitle || (node.label || kindLabel) !== kindLabel) && (
          <span>{kindLabel}</span>
        )}
      </div>

      {isTextLike && (
        <div className="node-text-wrap">
          <textarea
            className="node-textarea nodrag nowheel"
            rows={node.kind === "text_gen" ? 3 : 4}
            value={node.text ?? ""}
            placeholder={t("canvas.textValue")}
            onChange={(e) => node.onPatchNode(id, { text: e.target.value })}
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
            onUpload={
              node.kind === "image"
                ? (uri) => node.onUploadImage(id, uri)
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

      {node.jobStatus && <NodeRunMeta node={node} />}

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

function patchForJob(job: Job): Partial<NodeData> {
  const result = job.result ?? {};
  const patch: Partial<NodeData> = {
    jobId: job.id,
    jobStatus: job.status,
    jobError: job.error,
  };
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
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

function NodeRunMeta({ node }: { node: NodeRunState }) {
  const icon =
    node.jobStatus === "succeeded"
      ? "✅"
      : node.jobStatus === "failed" || node.jobStatus === "canceled"
        ? "❌"
        : "…";
  return (
    <div className="node-run-meta">
      <span aria-hidden>{icon}</span>
      {node.generatedAt && <time>{node.generatedAt}</time>}
    </div>
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
      <textarea
        rows={5}
        value={text}
        onChange={(e) => {
          onChange(refId, e.target.value, node.data.label);
        }}
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
            {a.name} ({a.kind})
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

function findBoundSegmentId(
  nodeId: string,
  nodes: CanvasNode[],
  edges: Edge[],
): number | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();

  const visit = (currentId: string): number | null => {
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    const incoming = edges
      .filter((e) => e.target === currentId)
      .sort(
        (a, b) =>
          ((a.data as { order?: number })?.order ?? 0) -
          ((b.data as { order?: number })?.order ?? 0),
      );

    for (const edge of incoming) {
      const source = byId.get(edge.source);
      if (!source) continue;
      if (source.data.kind === "text" && source.data.refId != null) {
        return source.data.refId;
      }
      const upstream = visit(source.id);
      if (upstream != null) return upstream;
    }
    return null;
  };

  return visit(nodeId);
}

function findVideoTargetSegmentId(
  nodeId: string,
  nodes: CanvasNode[],
  edges: Edge[],
  segments: SegmentRow[],
): number | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (node?.data.kind === "video_gen" && node.data.refId != null) {
    return node.data.refId;
  }

  const upstreamSegmentId = findBoundSegmentId(nodeId, nodes, edges);
  if (upstreamSegmentId != null) {
    return upstreamSegmentId;
  }

  return segments.length === 1 ? segments[0].id : null;
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
