/** Project asset gallery: display-only assets scoped to one project. */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Clock3,
  Database,
  Image as ImageIcon,
  MapPin,
  Package,
  Users,
} from "lucide-react";
import { api, type Asset, type AssetKind } from "../api/client";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "../components/ImagePreviewDialog";
import { BASE_URL } from "../api/client";

type AssetFilter = "all" | AssetKind;

const ASSET_FILTERS: AssetFilter[] = ["all", "character", "scene", "prop"];
const ASSET_GROUPS: AssetKind[] = ["character", "scene", "prop"];

export function ProjectAssetsPanel({ projectUid }: { projectUid: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [preview, setPreview] = useState<ImagePreviewState | null>(null);

  const assets = useQuery({
    queryKey: ["assets", projectUid],
    queryFn: () => api.listProjectAssets(projectUid),
  });

  useEffect(() => {
    if (!preview) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [preview]);

  const counts = useMemo(() => countByKind(assets.data ?? []), [assets.data]);
  const visibleGroups = ASSET_GROUPS.map((kind) => ({
    kind,
    assets: (assets.data ?? []).filter(
      (asset) => asset.kind === kind && (filter === "all" || filter === kind),
    ),
  })).filter((group) => filter === "all" || group.kind === filter);

  return (
    <section className="asset-gallery" aria-label={t("assets.heading")}>
      <div className="asset-mode-tabs" aria-label={t("assets.assetScope")}>
        <button type="button" className="asset-mode-tab active">
          <Archive size={15} aria-hidden />
          {t("assets.fixedAssets", { count: assets.data?.length ?? 0 })}
        </button>
        <button type="button" className="asset-mode-tab" disabled>
          <Clock3 size={15} aria-hidden />
          {t("assets.temporaryAssets", { count: 0 })}
        </button>
      </div>

      <div className="asset-filter-tabs" aria-label={t("assets.kind")}>
        {ASSET_FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className={
              filter === key ? "asset-filter-tab active" : "asset-filter-tab"
            }
            onClick={() => setFilter(key)}
          >
            {filterIcon(key)}
            {t(`assets.filter${cap(key)}`, {
              count: key === "all" ? assets.data?.length ?? 0 : counts[key],
            })}
          </button>
        ))}
      </div>

      {assets.isError && <p className="error small">{t("assets.error")}</p>}

      <div className="asset-gallery-body">
        {assets.isLoading && (
          <p className="asset-gallery-empty">{t("projects.loading")}</p>
        )}

        {!assets.isLoading &&
          visibleGroups.every((group) => group.assets.length === 0) && (
            <p className="asset-gallery-empty">{t("assets.emptyDisplay")}</p>
          )}

        {!assets.isLoading &&
          visibleGroups.map((group) => (
            <AssetGroup
              key={group.kind}
              kind={group.kind}
              assets={group.assets}
              onPreview={(asset) => {
                if (!asset.image_path) return;
                setPreview({ src: mediaUrl(asset.image_path), title: asset.name });
              }}
            />
          ))}
      </div>

      {preview && (
        <ImagePreviewDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </section>
  );
}

function AssetGroup({
  kind,
  assets,
  onPreview,
}: {
  kind: AssetKind;
  assets: Asset[];
  onPreview: (asset: Asset) => void;
}) {
  const { t } = useTranslation();
  if (assets.length === 0) return null;
  return (
    <section className="asset-display-group">
      <div className="asset-group-heading">
        <div className={`asset-group-label asset-group-${kind}`}>
          {filterIcon(kind)}
          <span>{t(`assets.group${cap(kind)}`)}</span>
        </div>
        <span className="asset-group-count">
          {t("assets.assetCount", { count: assets.length })}
        </span>
      </div>

      <ul className="asset-display-grid">
        {assets.map((asset) => (
          <li key={asset.id} className="asset-display-card">
            <button
              type="button"
              className="asset-display-image"
              disabled={!asset.image_path}
              onClick={() => onPreview(asset)}
              title={
                asset.image_path ? t("assets.previewAsset") : t("assets.pendingImage")
              }
              aria-label={
                asset.image_path ? t("assets.previewAsset") : t("assets.pendingImage")
              }
            >
              {asset.image_path ? (
                <img src={mediaUrl(asset.image_path)} alt={asset.name} />
              ) : (
                <span className="asset-display-placeholder">
                  <ImageIcon size={22} aria-hidden />
                  {t("assets.pendingImage")}
                </span>
              )}
              <span className={`asset-kind-badge asset-kind-${asset.kind}`}>
                {t(`assets.kind${cap(asset.kind)}`)}
              </span>
            </button>

            <div className="asset-display-card-body">
              <div className="asset-display-title-row">
                <strong>{asset.name}</strong>
                {!asset.image_path && (
                  <span className="asset-status-pill">{t("assets.waiting")}</span>
                )}
              </div>
              <p className="asset-display-meta">
                {t("assets.appearanceCount", { count: 0 })}
              </p>
              {asset.description && (
                <p className="asset-display-desc">{asset.description}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function countByKind(assets: Asset[]): Record<AssetKind, number> {
  return assets.reduce<Record<AssetKind, number>>(
    (acc, asset) => {
      acc[asset.kind] += 1;
      return acc;
    },
    { character: 0, prop: 0, scene: 0 },
  );
}

function filterIcon(kind: AssetFilter) {
  switch (kind) {
    case "all":
      return <Database size={15} aria-hidden />;
    case "character":
      return <Users size={15} aria-hidden />;
    case "scene":
      return <MapPin size={15} aria-hidden />;
    case "prop":
      return <Package size={15} aria-hidden />;
  }
}

function mediaUrl(uri: string): string {
  if (/^(https?:|data:|blob:)/.test(uri)) return uri;
  if (uri.startsWith("/")) return `${BASE_URL}${uri}`;
  return uri;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
