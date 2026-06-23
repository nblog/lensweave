/**
 * Projects page — the first screen (docs/04 §2.1). Shows "Create Project"
 * front and center, lists existing projects, and opens one into its detail
 * view. Server state is managed by TanStack Query.
 */
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { formatTimestamp } from "../utils/datetime";

export function ProjectsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });

  const createProject = useMutation({
    mutationFn: (newTitle: string) => api.createProject(newTitle),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setTitle("");
      setShowForm(false);
      navigate(`/projects/${project.uid}`);
    },
  });

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    e.preventDefault();
    if (title.trim()) createProject.mutate(title.trim());
  };

  return (
    <section className="projects">
      <div className="projects-header">
        <h2>{t("projects.heading")}</h2>
        {!showForm && (
          <button className="primary" onClick={() => setShowForm(true)}>
            {t("projects.create")}
          </button>
        )}
      </div>

      {showForm && (
        <form className="create-form" onSubmit={handleSubmit}>
          <label htmlFor="title">{t("projects.titleLabel")}</label>
          <input
            id="title"
            autoFocus
            value={title}
            placeholder={t("projects.titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="form-actions">
            <button type="submit" className="primary" disabled={!title.trim()}>
              {t("projects.submit")}
            </button>
            <button type="button" onClick={() => setShowForm(false)}>
              {t("projects.cancel")}
            </button>
          </div>
        </form>
      )}

      {projects.isLoading && <p className="muted">{t("projects.loading")}</p>}
      {projects.isError && <p className="error">{t("projects.error")}</p>}

      {projects.data && projects.data.length === 0 && (
        <p className="muted">{t("projects.empty")}</p>
      )}

      {projects.data && projects.data.length > 0 && (
        <ul className="project-list">
          {projects.data.map((p) => (
            <li key={p.id} className="project-card">
              <div>
                <span className="project-title">{p.title}</span>
                <span className="project-meta">
                  <Clock size={13} aria-hidden />
                  {t("projects.createdAt")}: {formatTimestamp(p.created_at)}
                </span>
              </div>
              <Link className="primary action-link" to={`/projects/${p.uid}`}>
                {t("projects.open")}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
