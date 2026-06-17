/**
 * Project detail page (docs/04 §2.3). After creating a project the user sees
 * only its episodes — assets live in the global library (ADR-005). Video
 * generation parameters live on VideoGen nodes in the EP workshop.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useNav } from "../store/nav";

export function ProjectPage({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const goWorkshop = useNav((s) => s.goWorkshop);

  const episodes = useQuery({
    queryKey: ["episodes", projectId],
    queryFn: () => api.listEpisodes(projectId),
  });

  const [title, setTitle] = useState("");

  const createEpisode = useMutation({
    mutationFn: () =>
      api.createEpisode(projectId, {
        episode_no: (episodes.data?.length ?? 0) + 1,
        title: title || `EP${(episodes.data?.length ?? 0) + 1}`,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["episodes", projectId] });
      setTitle("");
    },
  });

  return (
    <section className="panel">
      <h2>{t("project.episodes")}</h2>

      <form
        className="stacked-form"
        onSubmit={(e) => {
          e.preventDefault();
          createEpisode.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="ep-title">{t("project.episodeTitle")}</label>
          <input
            id="ep-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <button type="submit" className="primary">
          {t("project.addEpisode")}
        </button>
      </form>

      {episodes.data && episodes.data.length === 0 && (
        <p className="muted">{t("project.noEpisodes")}</p>
      )}
      <ul className="project-list">
        {episodes.data?.map((e) => (
          <li key={e.id} className="project-card">
            <div>
              <span className="project-title">
                EP{String(e.episode_no).padStart(2, "0")} · {e.title}
              </span>
            </div>
            <button className="primary" onClick={() => goWorkshop(projectId, e.id)}>
              {t("project.openWorkshop")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
