/** Global asset library: reusable visual assets available to every project. */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Image as ImageIcon,
  MapPin,
  Package,
  Plus,
  Users,
} from "lucide-react";
import { api, BASE_URL, type Asset, type AssetKind } from "../api/client";
import { AssetEditorDialog } from "../components/AssetEditorDialog";
import {
  AssetSaveDialog,
  ASSET_KIND_OPTIONS,
} from "../components/AssetSaveDialog";

type AssetFilter = "all" | AssetKind;

const ASSET_FILTERS: AssetFilter[] = ["all", "character", "prop", "scene"];
const ASSET_GROUPS = ASSET_KIND_OPTIONS;

export function GlobalAssetsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);

  const assets = useQuery({
    queryKey: ["global-assets"],
    queryFn: () => api.listGlobalAssets(),
  });

  const globalAssets = useMemo(() => assets.data ?? [], [assets.data]);
  const counts = useMemo(() => countByKind(globalAssets), [globalAssets]);
  const visibleGroups = ASSET_GROUPS.map((kind) => ({
    kind,
    assets: globalAssets.filter(
      (asset) => asset.kind === kind && (filter === "all" || filter === kind),
    ),
  })).filter((group) => filter === "all" || group.kind === filter);

  return (
    <section className="asset-gallery" aria-label={t("assets.globalHeading")}>
      <div className="projects-header">
        <div>
          <span className="project-page-kicker">{t("assets.scopeGlobal")}</span>
          <h2>{t("assets.globalHeading")}</h2>
          <p className="asset-page-intro">{t("assets.globalIntro")}</p>
        </div>
        <button
          type="button"
          className="asset-create-button"
          onClick={() => setIsCreateOpen(true)}
        >
          <Plus size={15} aria-hidden />
          {t("assets.uploadGlobalAsset")}
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
              count: key === "all" ? globalAssets.length : counts[key],
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
              onEdit={setEditingAsset}
            />
          ))}
      </div>

      {isCreateOpen && (
        <AssetSaveDialog
          defaultScope="global"
          scopeChoices={[{ scope: "global" }]}
          kicker={t("assets.scopeGlobal")}
          title={t("assets.uploadGlobalAsset")}
          intro={t("assets.uploadGlobalAssetIntro")}
          ariaLabel={t("assets.uploadGlobalAsset")}
          submitLabel={t("assets.saveGenerated")}
          onClose={() => setIsCreateOpen(false)}
          onSubmit={async (body) => {
            await api.createGlobalAsset(body);
            await queryClient.invalidateQueries({ queryKey: ["global-assets"] });
            await queryClient.invalidateQueries({ queryKey: ["assets"] });
            await queryClient.invalidateQueries({ queryKey: ["episode-assets"] });
            setIsCreateOpen(false);
          }}
        />
      )}
      {editingAsset && (
        <AssetEditorDialog
          asset={editingAsset}
          onClose={() => setEditingAsset(null)}
          onSave={async (body) => {
            await api.updateGlobalAsset(editingAsset.id, body);
            await invalidateAssetQueries(queryClient);
          }}
          onDelete={async () => {
            await api.deleteGlobalAsset(editingAsset.id);
            await invalidateAssetQueries(queryClient);
          }}
        />
      )}
    </section>
  );
}

function AssetGroup({
  kind,
  assets,
  onEdit,
}: {
  kind: AssetKind;
  assets: Asset[];
  onEdit: (asset: Asset) => void;
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
              className="asset-display-card-button"
              onClick={() => onEdit(asset)}
              title={t("assets.editAsset")}
              aria-label={t("assets.editAsset")}
            >
              <span className="asset-display-image">
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
              </span>

              <span className="asset-display-card-body">
                <span className="asset-display-title-row">
                  <strong>{asset.name}</strong>
                  {!asset.image_path && (
                    <span className="asset-status-pill">{t("assets.waiting")}</span>
                  )}
                </span>
                <span className="asset-display-meta">
                  {t("assets.appearanceCount", { count: 0 })}
                </span>
                {asset.description && (
                  <span className="asset-display-desc">{asset.description}</span>
                )}
              </span>
            </button>
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

async function invalidateAssetQueries(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["global-assets"] }),
    queryClient.invalidateQueries({ queryKey: ["assets"] }),
    queryClient.invalidateQueries({ queryKey: ["episode-assets"] }),
  ]);
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
