/**
 * Global asset library (docs/04 §2.4, ADR-005). Assets live here independent of
 * any project and are reused across projects. Create character / prop / scene
 * assets with an optional reference image; the EP workshop references them.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AssetKind } from "../api/client";

export function AssetLibraryPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const assets = useQuery({ queryKey: ["assets"], queryFn: () => api.listAssets() });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<AssetKind>("character");
  const [imagePath, setImagePath] = useState("");

  const createAsset = useMutation({
    mutationFn: () =>
      api.createAsset({ kind, name, image_path: imagePath || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assets"] });
      setName("");
      setImagePath("");
    },
  });

  return (
    <section className="panel">
      <h2>{t("assets.heading")}</h2>
      <p className="muted">{t("assets.intro")}</p>

      <div className="inline-form">
        <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
          <option value="character">{t("assets.kindCharacter")}</option>
          <option value="prop">{t("assets.kindProp")}</option>
          <option value="scene">{t("assets.kindScene")}</option>
        </select>
        <input
          placeholder={t("assets.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder={t("assets.imagePath")}
          value={imagePath}
          onChange={(e) => setImagePath(e.target.value)}
        />
        <button
          className="primary"
          disabled={!name.trim()}
          onClick={() => createAsset.mutate()}
        >
          {t("assets.add")}
        </button>
      </div>

      {assets.data && assets.data.length === 0 && (
        <p className="muted">{t("assets.empty")}</p>
      )}
      <ul className="chip-list">
        {assets.data?.map((a) => (
          <li key={a.id} className={`chip chip-${a.kind}`}>
            <strong>{a.name}</strong>
            <span className="chip-kind">{t(`assets.kind${cap(a.kind)}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
