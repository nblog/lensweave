/**
 * Projects page — the first screen (docs/04 §2.1). Shows "Create Project"
 * front and center, lists existing projects, and opens one into its detail
 * view. Server state is managed by TanStack Query.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarClock,
  Clock,
  FolderKanban,
  Hash,
  LockKeyhole,
  LoaderCircle,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Project } from "../api/client";
import { formatTimestamp } from "../utils/datetime";

export function ProjectsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [secondaryPassword, setSecondaryPassword] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [deleteSecondaryPassword, setDeleteSecondaryPassword] = useState("");

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  });
  const projectItems = projects.data ?? [];
  const latestProject = projectItems[0];

  const createProject = useMutation({
    mutationFn: (body: { title: string; secondary_password: string }) =>
      api.createProject(body),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setTitle("");
      setSecondaryPassword("");
      setShowForm(false);
      navigate(`/projects/${project.uid}`);
    },
  });

  const deleteProject = useMutation({
    mutationFn: (body: { projectUid: string; secondaryPassword: string }) =>
      api.deleteProject(body.projectUid, body.secondaryPassword),
    onSuccess: () => {
      setProjectToDelete(null);
      setDeleteSecondaryPassword("");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim() && secondaryPassword.length >= 4) {
      createProject.mutate({
        title: title.trim(),
        secondary_password: secondaryPassword,
      });
    }
  };

  const openDeleteDialog = (project: Project) => {
    deleteProject.reset();
    setDeleteSecondaryPassword("");
    setProjectToDelete(project);
  };

  const closeDeleteDialog = () => {
    if (deleteProject.isPending) return;
    setProjectToDelete(null);
    setDeleteSecondaryPassword("");
    deleteProject.reset();
  };

  const handleDeleteSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectToDelete || !deleteSecondaryPassword) return;
    deleteProject.mutate({
      projectUid: projectToDelete.uid,
      secondaryPassword: deleteSecondaryPassword,
    });
  };

  return (
    <section className="projects">
      <div className="projects-header">
        <div className="projects-heading-copy">
          <span className="projects-kicker">{t("projects.kicker")}</span>
          <h2>{t("projects.heading")}</h2>
          <div className="project-summary" aria-label={t("projects.summary")}>
            <span>
              <FolderKanban size={15} aria-hidden />
              {t("projects.total", { count: projectItems.length })}
            </span>
            <span>
              <CalendarClock size={15} aria-hidden />
              {latestProject
                ? t("projects.latest", {
                    time: formatTimestamp(latestProject.created_at),
                  })
                : t("projects.noLatest")}
            </span>
          </div>
        </div>
        {!showForm && (
          <button
            className="primary projects-create-button"
            onClick={() => setShowForm(true)}
          >
            <Plus size={16} aria-hidden />
            <span>{t("projects.create")}</span>
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
          <label htmlFor="secondary-password">
            {t("projects.secondaryPasswordLabel")}
          </label>
          <div className="password-field create-password-field">
            <LockKeyhole size={16} aria-hidden />
            <input
              id="secondary-password"
              type="password"
              autoComplete="new-password"
              value={secondaryPassword}
              placeholder={t("projects.secondaryPasswordPlaceholder")}
              onChange={(e) => setSecondaryPassword(e.target.value)}
            />
          </div>
          <p className="field-hint">{t("projects.secondaryPasswordHint")}</p>
          <div className="form-actions">
            <button
              type="submit"
              className="primary"
              disabled={
                !title.trim() ||
                secondaryPassword.length < 4 ||
                createProject.isPending
              }
            >
              <Plus size={16} aria-hidden />
              <span>{t("projects.submit")}</span>
            </button>
            <button type="button" onClick={() => setShowForm(false)}>
              <X size={16} aria-hidden />
              <span>{t("projects.cancel")}</span>
            </button>
          </div>
        </form>
      )}

      {projects.isLoading && (
        <p className="project-state muted">{t("projects.loading")}</p>
      )}
      {projects.isError && (
          <p className="project-state error">{t("projects.error")}</p>
      )}
      {deleteProject.isError && (
        !projectToDelete && (
          <p className="project-state error">{t("projects.deleteError")}</p>
        )
      )}

      {projects.data && projectItems.length === 0 && (
        <div className="project-empty">
          <span className="project-empty-icon">
            <FolderKanban size={26} aria-hidden />
          </span>
          <h3>{t("projects.emptyTitle")}</h3>
          <p>{t("projects.empty")}</p>
          {!showForm && (
            <button className="primary" onClick={() => setShowForm(true)}>
              <Plus size={16} aria-hidden />
              <span>{t("projects.create")}</span>
            </button>
          )}
        </div>
      )}

      {projects.data && projectItems.length > 0 && (
        <ul className="project-list">
          {projectItems.map((p) => {
            const isDeleting =
              deleteProject.isPending &&
              deleteProject.variables?.projectUid === p.uid;
            return (
              <li key={p.id} className="project-card">
                <Link className="project-card-main" to={`/projects/${p.uid}`}>
                  <span className="project-card-icon">
                    <FolderKanban size={20} aria-hidden />
                  </span>
                  <span className="project-card-copy">
                    <span className="project-title">{p.title}</span>
                    <span className="project-meta">
                      <Clock size={13} aria-hidden />
                      {t("projects.createdAt")}: {formatTimestamp(p.created_at)}
                    </span>
                    <span className="project-uid">
                      <Hash size={13} aria-hidden />
                      {t("projects.uid")}: {p.uid}
                    </span>
                  </span>
                </Link>
                <div className="project-card-actions">
                  <Link
                    className="action-link project-open-link"
                    to={`/projects/${p.uid}`}
                  >
                    <span>{t("projects.open")}</span>
                    <ArrowRight size={15} aria-hidden />
                  </Link>
                  <button
                    className="icon-btn project-delete-btn"
                    type="button"
                    aria-label={t("projects.deleteAria", { title: p.title })}
                    title={t("projects.delete")}
                    disabled={deleteProject.isPending}
                    onClick={() => openDeleteDialog(p)}
                  >
                    {isDeleting ? (
                      <LoaderCircle className="spin" size={17} aria-hidden />
                    ) : (
                      <Trash2 size={17} aria-hidden />
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {projectToDelete && (
        <div
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("projects.deleteTitle")}
          onMouseDown={closeDeleteDialog}
        >
          <form
            className="confirm-panel project-sensitive-panel"
            onSubmit={handleDeleteSubmit}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="confirm-close"
              type="button"
              onClick={closeDeleteDialog}
              disabled={deleteProject.isPending}
              aria-label={t("confirm.cancel")}
            >
              <X size={18} aria-hidden />
            </button>
            <div className="confirm-icon danger">
              <ShieldAlert size={22} aria-hidden />
            </div>
            <h3 className="confirm-title">{t("projects.deleteTitle")}</h3>
            <p className="confirm-message">
              {t("projects.deleteMessage", { title: projectToDelete.title })}
            </p>
            <label className="sensitive-label" htmlFor="project-delete-password">
              {t("projects.secondaryPasswordLabel")}
            </label>
            <div className="password-field sensitive-password-field">
              <LockKeyhole size={16} aria-hidden />
              <input
                id="project-delete-password"
                autoFocus
                type="password"
                autoComplete="current-password"
                value={deleteSecondaryPassword}
                onChange={(e) => setDeleteSecondaryPassword(e.target.value)}
              />
            </div>
            {deleteProject.isError && (
              <p className="error small">{t("projects.secondaryPasswordError")}</p>
            )}
            <div className="confirm-actions">
              <button
                type="button"
                onClick={closeDeleteDialog}
                disabled={deleteProject.isPending}
              >
                {t("confirm.cancel")}
              </button>
              <button
                type="submit"
                className="danger"
                disabled={!deleteSecondaryPassword || deleteProject.isPending}
              >
                {deleteProject.isPending
                  ? t("projects.deleting")
                  : t("confirm.delete")}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
