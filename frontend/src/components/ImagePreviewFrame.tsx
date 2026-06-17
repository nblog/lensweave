/**
 * Shared image frame used by both the canvas ImageNode (docs/04 §3.3) and the
 * global asset library (§2.4): a fixed-ratio thumbnail with corner controls —
 * an optional kind TAG (top-left), upload (top-right), full-preview/zoom
 * (bottom-left), and an optional retry (bottom-right). Replacing an existing
 * image asks for confirmation here, so the overwrite guardrail is consistent
 * everywhere the frame is used.
 */
import { useTranslation } from "react-i18next";
import { Maximize2, RotateCw, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { useConfirm } from "./confirm-context";
import { ACCEPTED_IMAGE_TYPES, readImageAsDataUri } from "../utils/image";

export function ImagePreviewFrame({
  src,
  alt,
  className,
  tag,
  onPreview,
  onUpload,
  onRetry,
  retryDisabled = false,
}: {
  src?: string;
  alt: string;
  className?: string;
  /** Optional badge rendered in the top-left corner (e.g. asset kind tag). */
  tag?: ReactNode;
  onPreview: (src: string, title: string) => void;
  onUpload?: (imageUri: string) => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();

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

  return (
    <div className={`node-media-frame ${className ?? ""}`}>
      {src ? <img src={src} alt={alt} /> : <span>{t("canvas.noPreview")}</span>}
      {tag && <span className="node-media-tag">{tag}</span>}
      {src && (
        <button
          className="node-preview nodrag"
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
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
      {onUpload && (
        <label
          className="node-upload nodrag"
          title={t("canvas.uploadImage")}
          aria-label={t("canvas.uploadImage")}
          onPointerDown={(e) => e.stopPropagation()}
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
