/**
 * Full-screen image preview/zoom modal, shared by the canvas and the asset
 * library. Opened from an ImagePreviewFrame's zoom control; offers download and
 * close. Data-URI and remote sources both download via a synthesized <a>.
 */
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";
import { downloadImage } from "../utils/image";

export type ImagePreviewState = { src: string; title: string };

export function ImagePreviewDialog({
  preview,
  onClose,
}: {
  preview: ImagePreviewState;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="image-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={preview.title}
      onMouseDown={onClose}
    >
      <div
        className="image-preview-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="image-preview-actions">
          <button
            className="image-preview-action"
            type="button"
            onClick={() => downloadImage(preview.src, preview.title)}
            title={t("canvas.downloadImage")}
            aria-label={t("canvas.downloadImage")}
          >
            <Download size={18} aria-hidden />
          </button>
          <button
            className="image-preview-action"
            type="button"
            onClick={onClose}
            title={t("canvas.closePreview")}
            aria-label={t("canvas.closePreview")}
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <img className="image-preview-full" src={preview.src} alt={preview.title} />
      </div>
    </div>
  );
}
