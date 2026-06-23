import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff, Trash2, X } from "lucide-react";
import {
  BASE_URL,
  type Asset,
  type AssetKind,
  type AssetScope,
  type AssetUpdate,
} from "../api/client";
import { ImagePreviewFrame } from "./ImagePreviewFrame";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "./ImagePreviewDialog";
import { useConfirm } from "./confirm-context";

const ASSET_KINDS: AssetKind[] = ["character", "prop", "scene"];

export function AssetEditorDialog({
  asset,
  onClose,
  onSave,
  onDelete,
}: {
  asset: Asset;
  onClose: () => void;
  onSave: (body: AssetUpdate) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const scope = readAssetScope(asset);
  const [kind, setKind] = useState<AssetKind>(asset.kind);
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description ?? "");
  const [imageUri, setImageUri] = useState<string | null>(asset.image_path);
  const [preview, setPreview] = useState<ImagePreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const isBusy = isSaving || isDeleting;

  const handleSubmit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("assets.nameRequired"));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await onSave({
        kind,
        name: trimmedName,
        description: description.trim() || null,
        spec: { ...(asset.spec ?? {}), asset_scope: scope },
        image_path: imageUri,
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : t("assets.updateError"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t("assets.deleteTitle"),
      message: t("assets.deleteMessage", { name: asset.name }),
      confirmLabel: t("confirm.delete"),
      danger: true,
    });
    if (!ok) return;

    setIsDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : t("assets.deleteError"),
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <div
        className="asset-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("assets.editAsset")}
      >
        <form className="asset-save-panel asset-editor-panel" onSubmit={handleSubmit}>
          <button
            className="asset-save-close"
            type="button"
            onClick={onClose}
            aria-label={t("confirm.cancel")}
            disabled={isBusy}
          >
            <X size={18} aria-hidden />
          </button>

          <div className="asset-editor-preview-stack">
            <ImagePreviewFrame
              src={imageUri ? mediaUrl(imageUri) : undefined}
              alt={name || t("assets.editAsset")}
              className="asset-save-preview-frame"
              tag={t(`assets.kind${cap(kind)}`)}
              previewTrigger="doubleClick"
              onPreview={(src, title) => setPreview({ src, title })}
              onUpload={(uri) => setImageUri(uri)}
            />
            <button
              type="button"
              className="asset-image-clear"
              onClick={() => setImageUri(null)}
              disabled={isBusy || !imageUri}
            >
              <ImageOff size={15} aria-hidden />
              {t("assets.deleteImage")}
            </button>
          </div>

          <div className="asset-save-body">
            <span className="project-page-kicker">
              {t(`assets.scope${cap(scope)}`)}
            </span>
            <h3>{t("assets.editAsset")}</h3>
            <p>{t("assets.editAssetIntro")}</p>

            <label htmlFor={`asset-editor-kind-${asset.id}`}>
              {t("assets.kind")}
            </label>
            <select
              id={`asset-editor-kind-${asset.id}`}
              value={kind}
              onChange={(event) => setKind(event.target.value as AssetKind)}
              disabled={isBusy}
            >
              {ASSET_KINDS.map((option) => (
                <option key={option} value={option}>
                  {t(`assets.kind${cap(option)}`)}
                </option>
              ))}
            </select>

            <label htmlFor={`asset-editor-name-${asset.id}`}>
              {t("assets.name")}
            </label>
            <input
              id={`asset-editor-name-${asset.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("assets.namePlaceholder")}
              disabled={isBusy}
              autoFocus
            />

            <label htmlFor={`asset-editor-description-${asset.id}`}>
              {t("assets.description")}
            </label>
            <textarea
              id={`asset-editor-description-${asset.id}`}
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("assets.descriptionPlaceholder")}
              disabled={isBusy}
            />

            {error && <p className="error small">{error}</p>}

            <div className="asset-save-actions asset-editor-actions">
              <button
                type="button"
                className="danger"
                onClick={() => void handleDelete()}
                disabled={isBusy}
              >
                <Trash2 size={15} aria-hidden />
                {isDeleting ? t("assets.deleting") : t("confirm.delete")}
              </button>
              <span className="asset-editor-action-spacer" />
              <button type="button" onClick={onClose} disabled={isBusy}>
                {t("confirm.cancel")}
              </button>
              <button className="primary" type="submit" disabled={isBusy}>
                {isSaving ? t("assets.saving") : t("assets.saveChanges")}
              </button>
            </div>
          </div>
        </form>
      </div>
      {preview && (
        <ImagePreviewDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

function readAssetScope(asset: Asset): AssetScope {
  if (isAssetScope(asset.scope)) return asset.scope;
  if (asset.project_id == null) return "global";
  if (asset.episode_id != null) return "temporary";
  const raw = asset.spec?.asset_scope;
  return isAssetScope(raw) ? raw : "fixed";
}

function isAssetScope(value: unknown): value is AssetScope {
  return value === "global" || value === "fixed" || value === "temporary";
}

function mediaUrl(uri: string): string {
  if (/^(https?:|data:|blob:)/.test(uri)) return uri;
  if (uri.startsWith("/")) return `${BASE_URL}${uri}`;
  return uri;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
