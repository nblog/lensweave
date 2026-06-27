/**
 * Shared asset creation dialog for global uploads, project uploads, and
 * generated-image saves. Callers own routing the selected scope to the correct
 * API endpoint; this component owns the repeated form state and validation.
 */
import { useId, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Clock3, Globe2, X } from "lucide-react";
import type { AssetKind, AssetScope } from "../api/client";
import { ImagePreviewFrame } from "./ImagePreviewFrame";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "./ImagePreviewDialog";

export const ASSET_KIND_OPTIONS: AssetKind[] = ["character", "prop", "scene"];
export const ASSET_SCOPE_OPTIONS: AssetScope[] = ["global", "fixed", "temporary"];

export type AssetScopeChoice = {
  scope: AssetScope;
  disabled?: boolean;
};

export type AssetSaveDialogValue = {
  scope: AssetScope;
  kind: AssetKind;
  name: string;
  description: string | null;
  spec: Record<string, unknown>;
  image_path: string;
};

export function AssetSaveDialog({
  title,
  intro,
  kicker,
  ariaLabel,
  submitLabel,
  initialName = "",
  initialImageUri = null,
  initialPreviewSrc,
  defaultScope,
  scopeChoices,
  onClose,
  onSubmit,
}: {
  title: string;
  intro: string;
  kicker: string;
  ariaLabel: string;
  submitLabel: string;
  initialName?: string;
  initialImageUri?: string | null;
  initialPreviewSrc?: string;
  defaultScope: AssetScope;
  scopeChoices: AssetScopeChoice[];
  onClose: () => void;
  onSubmit: (body: AssetSaveDialogValue) => Promise<void>;
}) {
  const { t } = useTranslation();
  const idPrefix = useId().replace(/:/g, "");
  const firstEnabledScope =
    scopeChoices.find((choice) => !choice.disabled)?.scope ?? defaultScope;
  const initialScope =
    scopeChoices.some(
      (choice) => choice.scope === defaultScope && !choice.disabled,
    )
      ? defaultScope
      : firstEnabledScope;
  const [scope, setScope] = useState<AssetScope>(initialScope);
  const [kind, setKind] = useState<AssetKind>("character");
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [imageUri, setImageUri] = useState<string | null>(initialImageUri);
  const [previewSrc, setPreviewSrc] = useState<string | null>(
    initialPreviewSrc ?? initialImageUri,
  );
  const [fullPreview, setFullPreview] = useState<ImagePreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const showScopePicker = scopeChoices.length > 1;

  const handleSubmit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("assets.nameRequired"));
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
      aria-label={ariaLabel}
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
          src={previewSrc ?? undefined}
          alt={name || title}
          className="asset-save-preview-frame"
          onPreview={(src, title) => setFullPreview({ src, title })}
          previewTrigger="doubleClick"
          onUpload={(uri) => {
            setImageUri(uri);
            setPreviewSrc(uri);
          }}
        />

        <div className="asset-save-body">
          <span className="project-page-kicker">{kicker}</span>
          <h3>{title}</h3>
          <p>{intro}</p>

          {showScopePicker && (
            <div className="asset-save-field">
              <label>{t("assets.assetScope")}</label>
              <div className="asset-scope-options" role="group">
                {scopeChoices.map(({ scope: option, disabled }) => (
                  <button
                    key={option}
                    type="button"
                    className={
                      scope === option
                        ? "asset-scope-option active"
                        : "asset-scope-option"
                    }
                    onClick={() => setScope(option)}
                    disabled={isSaving || disabled}
                  >
                    {assetScopeIcon(option, 14)}
                    {t(`assets.scope${assetScopeLabelSuffix(option)}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="asset-save-field-row">
            <div className="asset-save-field asset-save-kind-field">
              <label htmlFor={`${idPrefix}-kind`}>{t("assets.kind")}</label>
              <select
                id={`${idPrefix}-kind`}
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
            </div>

            <div className="asset-save-field">
              <label htmlFor={`${idPrefix}-name`}>{t("assets.name")}</label>
              <input
                id={`${idPrefix}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("assets.namePlaceholder")}
                disabled={isSaving}
                autoFocus
              />
            </div>
          </div>

          <div className="asset-save-field">
            <label htmlFor={`${idPrefix}-description`}>
              {t("assets.description")}
            </label>
            <textarea
              id={`${idPrefix}-description`}
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("assets.descriptionPlaceholder")}
              disabled={isSaving}
            />
          </div>

          {error && <p className="error small">{error}</p>}

          <div className="asset-save-actions">
            <button type="button" onClick={onClose} disabled={isSaving}>
              {t("confirm.cancel")}
            </button>
            <button className="primary" type="submit" disabled={isSaving}>
              {isSaving ? t("assets.saving") : submitLabel}
            </button>
          </div>
        </div>
      </form>
      {fullPreview && (
        <ImagePreviewDialog
          preview={fullPreview}
          onClose={() => setFullPreview(null)}
        />
      )}
    </div>
  );
}

export function assetScopeIcon(scope: AssetScope, size = 15) {
  switch (scope) {
    case "global":
      return <Globe2 size={size} aria-hidden />;
    case "fixed":
      return <Archive size={size} aria-hidden />;
    case "temporary":
      return <Clock3 size={size} aria-hidden />;
  }
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
