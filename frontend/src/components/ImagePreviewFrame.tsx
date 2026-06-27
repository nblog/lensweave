/**
 * Shared image frame used by both the canvas ImageNode (docs/04 §3.3) and the
 * project asset panel (§2.4): a fixed-ratio thumbnail with corner controls —
 * an optional kind TAG (top-left), upload (top-right), a configurable
 * bottom-left action, optional double-click preview, and an optional retry
 * (bottom-right). Replacing an existing image asks for confirmation here, so
 * the overwrite guardrail is consistent everywhere the frame is used.
 */
import { useTranslation } from "react-i18next";
import { Maximize2, RotateCw, Star, Upload } from "lucide-react";
import type { ClipboardEvent, ReactNode } from "react";
import { useConfirm } from "./confirm-context";
import {
  ACCEPTED_IMAGE_TYPES,
  imageFileFromClipboard,
  readImageAsDataUri,
} from "../utils/image";

type PreviewTrigger = "button" | "doubleClick";

export function ImagePreviewFrame({
  src,
  alt,
  className,
  tag,
  onPreview,
  previewTrigger = "button",
  onUpload,
  onRetry,
  onFavorite,
  favoriteActive = false,
  retryDisabled = false,
}: {
  src?: string;
  alt: string;
  className?: string;
  /** Optional badge rendered in the top-left corner (e.g. asset kind tag). */
  tag?: ReactNode;
  onPreview?: (src: string, title: string) => void;
  previewTrigger?: PreviewTrigger;
  onUpload?: (imageUri: string) => void;
  onRetry?: () => void;
  onFavorite?: () => void;
  favoriteActive?: boolean;
  retryDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const favoriteLabel = favoriteActive
    ? t("assets.generatedSaved")
    : t("assets.addFromGenerated");

  const handleFile = async (file: File) => {
    if (!onUpload) return;
    // Replacing an existing image is easy to do by accident — confirm first.
    if (src) {
      const ok = await confirm({
        title: t("confirm.replaceImageTitle"),
        message: t("confirm.replaceImageMessage"),
        confirmLabel: t("confirm.replace"),
      });
      if (!ok) return;
    }
    readImageAsDataUri(file, onUpload);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!onUpload) return;
    const file = imageFileFromClipboard(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    void handleFile(file);
  };

  return (
    <div
      className={`node-media-frame ${
        previewTrigger === "doubleClick" && src ? "node-media-frame-dbl-preview " : ""
      }${className ?? ""}`}
      title={
        previewTrigger === "doubleClick" && src
          ? t("canvas.doubleClickPreview")
          : onUpload
            ? t("canvas.pasteImage")
            : undefined
      }
      tabIndex={onUpload ? 0 : undefined}
      aria-label={onUpload ? t("canvas.pasteImage") : undefined}
      onPaste={handlePaste}
      onDoubleClick={(e) => {
        if (!src || !onPreview || previewTrigger !== "doubleClick") return;
        e.stopPropagation();
        onPreview(src, alt);
      }}
    >
      {src ? (
        <img src={src} alt={alt} />
      ) : (
        <span>{onUpload ? t("canvas.pasteImage") : t("canvas.noPreview")}</span>
      )}
      {tag && <span className="node-media-tag">{tag}</span>}
      {src && onPreview && previewTrigger === "button" && (
        <button
          className="node-preview nodrag"
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPreview(src, alt);
          }}
          title={t("canvas.previewImage")}
          aria-label={t("canvas.previewImage")}
        >
          <Maximize2 size={14} aria-hidden />
        </button>
      )}
      {src && onFavorite && (
        <button
          className={`node-favorite nodrag${favoriteActive ? " active" : ""}`}
          type="button"
          aria-pressed={favoriteActive}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
          title={favoriteLabel}
          aria-label={favoriteLabel}
        >
          <Star
            size={14}
            fill={favoriteActive ? "currentColor" : "none"}
            aria-hidden
          />
        </button>
      )}
      {onUpload && (
        <label
          className="node-upload nodrag"
          title={t("canvas.uploadImage")}
          aria-label={t("canvas.uploadImage")}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <input
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.currentTarget.value = "";
            }}
          />
          <Upload size={14} aria-hidden />
        </label>
      )}
      {onRetry && (
        <button
          className="node-retry nodrag"
          disabled={retryDisabled}
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          title={t("canvas.retry")}
          aria-label={t("canvas.retry")}
        >
          <RotateCw size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
