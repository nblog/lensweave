/** Project asset gallery: project fixed / episode temporary assets. */
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Clock3,
  Database,
  Image as ImageIcon,
  MapPin,
  Package,
  Plus,
  Users,
  X,
} from "lucide-react";
import { api, type Asset, type AssetKind, type AssetScope } from "../api/client";
import { AssetEditorDialog } from "../components/AssetEditorDialog";
import { ImagePreviewFrame } from "../components/ImagePreviewFrame";
import { BASE_URL } from "../api/client";

type AssetFilter = "all" | AssetKind;
type ProjectAssetScope = Extract<AssetScope, "fixed" | "temporary">;

const ASSET_FILTERS: AssetFilter[] = ["all", "character", "prop", "scene"];
const ASSET_GROUPS: AssetKind[] = ["character", "prop", "scene"];
const PROJECT_ASSET_SCOPE_OPTIONS: ProjectAssetScope[] = ["fixed", "temporary"];

export function ProjectAssetsPanel({
  projectUid,
  episodeId,
}: {
  projectUid: string;
  episodeId: number | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<ProjectAssetScope>("fixed");
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);

  const assets = useQuery({
    queryKey: ["assets", projectUid, episodeId],
    queryFn: () =>
      episodeId ? api.listEpisodeAssets(episodeId) : api.listProjectAssets(projectUid),
  });

  const allAssets = useMemo(() => assets.data ?? [], [assets.data]);
  const fixedAssets = useMemo(
    () => allAssets.filter((asset) => readAssetScope(asset) === "fixed"),
    [allAssets],
  );
  const temporaryAssets = useMemo(
    () => allAssets.filter((asset) => readAssetScope(asset) === "temporary"),
    [allAssets],
  );
  const activeScope: ProjectAssetScope =
    scope === "temporary" && !episodeId ? "fixed" : scope;
  const scopedAssets = activeScope === "fixed" ? fixedAssets : temporaryAssets;
  const counts = useMemo(() => countByKind(scopedAssets), [scopedAssets]);
  const scopeCounts: Record<ProjectAssetScope, number> = {
    fixed: fixedAssets.length,
    temporary: temporaryAssets.length,
  };
  const visibleGroups = ASSET_GROUPS.map((kind) => ({
    kind,
    assets: scopedAssets.filter(
      (asset) => asset.kind === kind && (filter === "all" || filter === kind),
    ),
  })).filter((group) => filter === "all" || group.kind === filter);

  return (
    <section className="asset-gallery" aria-label={t("assets.heading")}>
      <div className="asset-gallery-toolbar">
        <div className="asset-mode-tabs" aria-label={t("assets.assetScope")}>
          {PROJECT_ASSET_SCOPE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={
                activeScope === option ? "asset-mode-tab active" : "asset-mode-tab"
              }
              onClick={() => setScope(option)}
              disabled={option === "temporary" && !episodeId}
            >
              {scopeIcon(option)}
              {t(`assets.scopeTab${cap(option)}`, {
                count: scopeCounts[option],
              })}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="asset-create-button"
          onClick={() => setIsCreateOpen(true)}
        >
          <Plus size={15} aria-hidden />
          {t("assets.uploadAsset")}
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
              count: key === "all" ? scopedAssets.length : counts[key],
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
        <AssetCreateDialog
          defaultScope={activeScope}
          episodeId={episodeId}
          onClose={() => setIsCreateOpen(false)}
          onSubmit={async (body) => {
            if (body.scope === "temporary") {
              if (!episodeId) throw new Error(t("assets.episodeRequired"));
              await api.createEpisodeAsset(episodeId, body);
            } else {
              await api.createProjectAsset(projectUid, body);
            }
            await queryClient.invalidateQueries({ queryKey: ["assets"] });
            if (episodeId) {
              await queryClient.invalidateQueries({
                queryKey: ["episode-assets", episodeId],
              });
            }
            setIsCreateOpen(false);
          }}
        />
      )}
      {editingAsset && (
        <AssetEditorDialog
          asset={editingAsset}
          onClose={() => setEditingAsset(null)}
          onSave={async (body) => {
            const assetScope = readAssetScope(editingAsset);
            if (assetScope === "temporary") {
              const targetEpisodeId = editingAsset.episode_id ?? episodeId;
              if (!targetEpisodeId) throw new Error(t("assets.episodeRequired"));
              await api.updateEpisodeAsset(targetEpisodeId, editingAsset.id, body);
            } else {
              await api.updateProjectAsset(projectUid, editingAsset.id, body);
            }
            await invalidateAssetQueries(queryClient);
          }}
          onDelete={async () => {
            const assetScope = readAssetScope(editingAsset);
            if (assetScope === "temporary") {
              const targetEpisodeId = editingAsset.episode_id ?? episodeId;
              if (!targetEpisodeId) throw new Error(t("assets.episodeRequired"));
              await api.deleteEpisodeAsset(targetEpisodeId, editingAsset.id);
            } else {
              await api.deleteProjectAsset(projectUid, editingAsset.id);
            }
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

function AssetCreateDialog({
  defaultScope,
  episodeId,
  onClose,
  onSubmit,
}: {
  defaultScope: ProjectAssetScope;
  episodeId: number | null;
  onClose: () => void;
  onSubmit: (body: {
    scope: ProjectAssetScope;
    kind: AssetKind;
    name: string;
    description: string | null;
    spec: Record<string, unknown>;
    image_path: string | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<ProjectAssetScope>(defaultScope);
  const [kind, setKind] = useState<AssetKind>("character");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("assets.nameRequired"));
      return;
    }
    if (scope === "temporary" && !episodeId) {
      setError(t("assets.episodeRequired"));
      return;
    }
    if (!imageUri) {
      setError(t("assets.imageRequired"));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSubmit({
        scope,
        kind,
        name: trimmedName,
        description: description.trim() || null,
        spec: { asset_scope: scope },
        image_path: imageUri,
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
      aria-label={t("assets.uploadAsset")}
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

        <ImagePreviewFrame
          src={imageUri ?? undefined}
          alt={name || t("assets.uploadAsset")}
          className="asset-save-preview-frame"
          onUpload={(uri) => setImageUri(uri)}
        />

        <div className="asset-save-body">
          <span className="project-page-kicker">{t("assets.assetScope")}</span>
          <h3>{t("assets.uploadAsset")}</h3>
          <p>{t("assets.uploadAssetIntro")}</p>

          <label>{t("assets.assetScope")}</label>
          <div className="asset-scope-options" role="group">
            {PROJECT_ASSET_SCOPE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={
                  scope === option
                    ? "asset-scope-option active"
                    : "asset-scope-option"
                }
                onClick={() => setScope(option)}
                disabled={isSaving || (option === "temporary" && !episodeId)}
              >
                {scopeIcon(option, 14)}
                {t(`assets.scope${cap(option)}`)}
              </button>
            ))}
          </div>

          <label htmlFor="project-asset-kind">{t("assets.kind")}</label>
          <select
            id="project-asset-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as AssetKind)}
            disabled={isSaving}
          >
            {ASSET_GROUPS.map((option) => (
              <option key={option} value={option}>
                {t(`assets.kind${cap(option)}`)}
              </option>
            ))}
          </select>

          <label htmlFor="project-asset-name">{t("assets.name")}</label>
          <input
            id="project-asset-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("assets.namePlaceholder")}
            disabled={isSaving}
            autoFocus
          />

          <label htmlFor="project-asset-description">{t("assets.description")}</label>
          <textarea
            id="project-asset-description"
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
    queryClient.invalidateQueries({ queryKey: ["assets"] }),
    queryClient.invalidateQueries({ queryKey: ["episode-assets"] }),
  ]);
}

function readAssetScope(asset: Asset): AssetScope {
  if (isAssetScope(asset.scope)) return asset.scope;
  if (asset.project_id == null) return "global";
  if (asset.episode_id != null) return "temporary";
  const raw = asset.spec?.asset_scope;
  return isAssetScope(raw) ? raw : "fixed";
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

function scopeIcon(scope: AssetScope, size = 15) {
  switch (scope) {
    case "fixed":
      return <Archive size={size} aria-hidden />;
    case "temporary":
      return <Clock3 size={size} aria-hidden />;
    case "global":
      return null;
  }
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
