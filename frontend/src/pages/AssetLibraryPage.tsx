/**
 * Global asset library (docs/04 §2.4, ADR-005). Assets live here independent of
 * any project and are reused across projects. An asset is an uploaded image
 * tagged by kind (character / prop / scene) with a required name and optional
 * description — reusing the canvas ImageNode frame (upload → tag → zoom): the
 * image is read into a data URI and stored on `Asset.image_path` (the image URI
 * binding for downstream nodes). Deleting an asset asks for confirmation.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Trash2 } from "lucide-react";
import { api, type Asset, type AssetKind } from "../api/client";
import { ImagePreviewFrame } from "../components/ImagePreviewFrame";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "../components/ImagePreviewDialog";
import { useConfirm } from "../components/confirm-context";
import { formatTimestamp } from "../utils/datetime";

const ASSET_KINDS: AssetKind[] = ["character", "prop", "scene"];

export function AssetLibraryPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();

  const assets = useQuery({ queryKey: ["assets"], queryFn: () => api.listAssets() });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<AssetKind>("character");
  const [imageUri, setImageUri] = useState("");
  const [preview, setPreview] = useState<ImagePreviewState | null>(null);

  useEffect(() => {
    if (!preview) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [preview]);

  const createAsset = useMutation({
    mutationFn: () =>
      api.createAsset({
        kind,
        name,
        description: description.trim() || null,
        image_path: imageUri || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      setName("");
      setDescription("");
      setImageUri("");
      setKind("character");
    },
  });

  const deleteAsset = useMutation({
    mutationFn: (id: number) => api.deleteAsset(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  const handleDelete = async (asset: Asset) => {
    const ok = await confirm({
      title: t("assets.deleteTitle"),
      message: t("assets.deleteMessage", { name: asset.name }),
      confirmLabel: t("confirm.delete"),
      danger: true,
    });
    if (ok) deleteAsset.mutate(asset.id);
  };

  return (
    <section className="panel">
      <h2>{t("assets.heading")}</h2>
      <p className="muted">{t("assets.intro")}</p>

      <div className="asset-form">
        {/* Upload + preview + tag, shared with the canvas ImageNode frame. */}
        <ImagePreviewFrame
          src={imageUri || undefined}
          alt={name || t("assets.name")}
          className="asset-form-frame"
          tag={t(`assets.kind${cap(kind)}`)}
          onPreview={(src, title) => setPreview({ src, title })}
          onUpload={setImageUri}
        />

        <div className="asset-fields">
          <div className="field">
            <label htmlFor="asset-name">
              {t("assets.name")} <span className="required">*</span>
            </label>
            <input
              id="asset-name"
              className="field-input-sm"
              placeholder={t("assets.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="asset-desc">{t("assets.description")}</label>
            <textarea
              id="asset-desc"
              rows={3}
              placeholder={t("assets.descriptionPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="field">
            <span className="field-label">{t("assets.tag")}</span>
            <div className="tag-picker">
              {ASSET_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`tag-chip tag-${k}${kind === k ? " active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {t(`assets.kind${cap(k)}`)}
                </button>
              ))}
            </div>
          </div>

          <button
            className="primary"
            disabled={!name.trim() || !imageUri || createAsset.isPending}
            onClick={() => createAsset.mutate()}
          >
            {t("assets.add")}
          </button>
        </div>
      </div>

      {assets.data && assets.data.length === 0 && (
        <p className="muted">{t("assets.empty")}</p>
      )}

      <ul className="asset-grid">
        {assets.data?.map((a) => (
          <li key={a.id} className="asset-card">
            <div className="asset-thumb">
              {a.image_path ? (
                <img src={a.image_path} alt={a.name} />
              ) : (
                <span className="asset-thumb-empty">{t("assets.noImage")}</span>
              )}
              <span className={`tag-chip tag-${a.kind} asset-card-tag`}>
                {t(`assets.kind${cap(a.kind)}`)}
              </span>
              <button
                className="asset-delete"
                type="button"
                onClick={() => handleDelete(a)}
                title={t("confirm.delete")}
                aria-label={t("confirm.delete")}
              >
                <Trash2 size={15} aria-hidden />
              </button>
            </div>
            <div className="asset-card-body">
              <strong className="asset-card-title">{a.name}</strong>
              {a.description && (
                <p className="asset-card-desc">{a.description}</p>
              )}
              <span className="asset-card-meta">
                <Clock size={12} aria-hidden />
                {formatTimestamp(a.created_at)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {preview && (
        <ImagePreviewDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </section>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
