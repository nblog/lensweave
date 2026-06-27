import { useTranslation } from "react-i18next";
import type { AssetKind } from "../api/client";
import { ASSET_KIND_OPTIONS, assetKindLabelSuffix } from "./assetOptions";

export function AssetFormFields({
  idPrefix,
  kind,
  name,
  description,
  disabled,
  onKindChange,
  onNameChange,
  onDescriptionChange,
}: {
  idPrefix: string;
  kind: AssetKind;
  name: string;
  description: string;
  disabled: boolean;
  onKindChange: (kind: AssetKind) => void;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <div className="asset-save-field-row">
        <div className="asset-save-field asset-save-kind-field">
          <label htmlFor={`${idPrefix}-kind`}>{t("assets.kind")}</label>
          <select
            id={`${idPrefix}-kind`}
            value={kind}
            onChange={(event) => onKindChange(event.target.value as AssetKind)}
            disabled={disabled}
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
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={t("assets.namePlaceholder")}
            disabled={disabled}
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
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder={t("assets.descriptionPlaceholder")}
          disabled={disabled}
        />
      </div>
    </>
  );
}
