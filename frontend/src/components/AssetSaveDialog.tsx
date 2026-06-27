/**
 * Shared asset creation dialog for global uploads, project uploads, and
 * generated-image saves. Callers own routing the selected scope to the correct
 * API endpoint; this component owns the repeated form state and validation.
 */
import { useId, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { AssetKind, AssetScope } from "../api/client";
import { AssetFormFields } from "./AssetFormFields";
import { ImagePreviewFrame } from "./ImagePreviewFrame";
import {
  ImagePreviewDialog,
  type ImagePreviewState,
} from "./ImagePreviewDialog";
import { assetScopeIcon, assetScopeLabelSuffix } from "./assetOptions";

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

          <AssetFormFields
            idPrefix={idPrefix}
            kind={kind}
            name={name}
            description={description}
            disabled={isSaving}
            onKindChange={setKind}
            onNameChange={setName}
            onDescriptionChange={setDescription}
          />

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
