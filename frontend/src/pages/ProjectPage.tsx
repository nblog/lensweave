/**
 * Project detail page (docs/04 §2.3). After creating a project the user sees
 * its series navigation on the left and the selected project page on the right.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronRight,
  Clapperboard,
  Image as ImageIcon,
  ListVideo,
  Plus,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { ProjectAssetsPanel } from "./ProjectAssetsPanel";

type ProjectStage = "script" | "assets";

const formatEpisodeCode = (episodeNo: number) => `EP0${episodeNo}`;

const displayEpisodeTitle = (episode: { episode_no: number; title: string }) => {
  const legacyAutoTitle = `EP${episode.episode_no}`;
  return episode.title === legacyAutoTitle
    ? formatEpisodeCode(episode.episode_no)
    : episode.title;
};

export function ProjectPage({ projectUid }: { projectUid: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [showCreateEpisode, setShowCreateEpisode] = useState(false);
  const [activeStage, setActiveStage] = useState<ProjectStage>("assets");
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<number | null>(null);

  const project = useQuery({
    queryKey: ["project", projectUid],
    queryFn: () => api.getProject(projectUid),
  });

  const episodes = useQuery({
    queryKey: ["episodes", projectUid],
    queryFn: () => api.listEpisodes(projectUid),
  });

  const [title, setTitle] = useState("");
  const firstEpisode = episodes.data?.[0] ?? null;
  const selectedEpisode =
    episodes.data?.find((episode) => episode.id === selectedEpisodeId) ??
    firstEpisode;
  const episodeCount = episodes.data?.length ?? 0;
  const projectTitle = project.data?.title ?? t("project.workspaceTitle");
  const activeHeading =
    activeStage === "assets"
      ? {
          kicker: t("project.step02"),
          title: `${t("project.stageAssetsIndex")} ${t("project.stageAssets")}`,
          intro: t("assets.intro"),
        }
      : {
          kicker: t("project.step01"),
          title: `${t("project.stageScriptIndex")} ${t("project.stageScript")}`,
          intro: projectTitle,
        };
  const defaultEpisodeTitle = useMemo(
    () => formatEpisodeCode(episodeCount + 1),
    [episodeCount],
  );

  const createEpisode = useMutation({
    mutationFn: () =>
      api.createEpisode(projectUid, {
        episode_no: episodeCount + 1,
        title: title.trim() || defaultEpisodeTitle,
      }),
    onSuccess: (episode) => {
      void qc.invalidateQueries({ queryKey: ["episodes", projectUid] });
      setSelectedEpisodeId(episode.id);
      setTitle("");
      setShowCreateEpisode(false);
    },
  });

  return (
    <section className="project-workbench" aria-label={t("project.workspace")}>
      <aside className="project-sidebar">
        <div className="series-panel">
          <div className="series-header">
            <div className="series-kicker">
              <ListVideo size={15} aria-hidden />
              <span>{t("project.series")}</span>
              <span>·</span>
              <strong>{t("project.episodeCount", { count: episodeCount })}</strong>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setShowCreateEpisode((value) => !value)}
              title={t("project.addEpisode")}
              aria-label={t("project.addEpisode")}
            >
              <Plus size={15} aria-hidden />
            </button>
          </div>

          {showCreateEpisode && (
            <form
              className="episode-quick-form"
              onSubmit={(e) => {
                e.preventDefault();
                createEpisode.mutate();
              }}
            >
              <label htmlFor="ep-title">{t("project.episodeTitle")}</label>
              <div className="episode-create-row">
                <input
                  id="ep-title"
                  autoFocus
                  value={title}
                  placeholder={defaultEpisodeTitle}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <button
                  type="submit"
                  className="icon-btn primary-icon"
                  disabled={createEpisode.isPending}
                  title={t("project.addEpisode")}
                  aria-label={t("project.addEpisode")}
                >
                  <Plus size={15} aria-hidden />
                </button>
              </div>
            </form>
          )}

          {episodes.isLoading && (
            <p className="muted small">{t("projects.loading")}</p>
          )}
          {episodes.isError && <p className="error small">{t("projects.error")}</p>}
          {episodes.data && episodes.data.length === 0 && (
            <p className="empty-list-note">{t("project.noEpisodes")}</p>
          )}

          <ol className="series-list">
            {episodes.data?.map((episode) => (
              <li key={episode.id}>
                <button
                  type="button"
                  className={
                    episode.id === selectedEpisode?.id
                      ? "series-item active"
                      : "series-item"
                  }
                  onClick={() => setSelectedEpisodeId(episode.id)}
                >
                  <span className="series-index">
                    {formatEpisodeCode(episode.episode_no)}
                  </span>
                  <span className="series-title">
                    {displayEpisodeTitle(episode)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <nav className="project-stage-panel" aria-label={t("project.workspace")}>
          <div className="stage-list">
            <button
              type="button"
              className={activeStage === "script" ? "stage-row active" : "stage-row"}
              onClick={() => setActiveStage("script")}
            >
              <BookOpen size={24} aria-hidden />
              <span className="stage-copy">
                <strong>
                  {t("project.stageScriptIndex")} {t("project.stageScript")}
                </strong>
                <span>{t("project.step01")}</span>
              </span>
            </button>

            <button
              type="button"
              className={activeStage === "assets" ? "stage-row active" : "stage-row"}
              onClick={() => setActiveStage("assets")}
            >
              <ImageIcon size={24} aria-hidden />
              <span className="stage-copy">
                <strong>
                  {t("project.stageAssetsIndex")} {t("project.stageAssets")}
                </strong>
                <span>{t("project.step02")}</span>
              </span>
            </button>

            {selectedEpisode ? (
              <Link
                className="stage-row"
                to={`/projects/${projectUid}/episodes/${selectedEpisode.id}/workshop`}
              >
                <Clapperboard size={24} aria-hidden />
                <span className="stage-copy">
                  <strong>
                    {t("project.stageWorkshopIndex")} {t("project.stageWorkshop")}
                  </strong>
                  <span>{t("project.step03")}</span>
                </span>
                <ChevronRight size={18} aria-hidden />
              </Link>
            ) : (
              <button type="button" className="stage-row muted-row" disabled>
                <Clapperboard size={24} aria-hidden />
                <span className="stage-copy">
                  <strong>
                    {t("project.stageWorkshopIndex")} {t("project.stageWorkshop")}
                  </strong>
                  <span>{t("project.step03")}</span>
                </span>
              </button>
            )}
          </div>
        </nav>
      </aside>

      <main className="project-page-panel">
        <div className="project-page-heading">
          <span className="project-page-kicker">{activeHeading.kicker}</span>
          <h2>{activeHeading.title}</h2>
          <p>{activeHeading.intro}</p>
        </div>

        {activeStage === "assets" ? (
          <ProjectAssetsPanel
            projectUid={projectUid}
            episodeId={selectedEpisode?.id ?? null}
          />
        ) : (
          <section className="script-page-section">
            <div className="script-page-shell">
              <BookOpen size={24} aria-hidden />
              <div>
                <h3>{t("project.scriptBaseline")}</h3>
                <p>
                  {selectedEpisode
                    ? t("project.selectedEpisode", {
                        episode: formatEpisodeCode(selectedEpisode.episode_no),
                        title: displayEpisodeTitle(selectedEpisode),
                      })
                    : projectTitle}
                </p>
              </div>
            </div>
            {selectedEpisode && (
              <Link
                className="project-page-workshop-link"
                to={`/projects/${projectUid}/episodes/${selectedEpisode.id}/workshop`}
              >
                <Clapperboard size={24} aria-hidden />
                <span>
                  <strong>{t("project.stageWorkshop")}</strong>
                  <small>{t("project.step03")}</small>
                </span>
                <ChevronRight size={18} aria-hidden />
              </Link>
            )}
          </section>
        )}
      </main>
    </section>
  );
}
