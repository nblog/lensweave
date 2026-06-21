/** Admin console for local user accounts. */
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { api, type UserAccount, type UserUpdate } from "../api/client";
import { useAuth } from "../auth/auth-context";
import { useConfirm } from "../components/confirm-context";
import { formatTimestamp } from "../utils/datetime";

export function AdminUsersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { username } = useAuth();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserAccount | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: api.listUsers,
  });

  const userItems = users.data ?? [];
  const activeCount = userItems.filter((user) => user.is_active).length;
  const adminCount = userItems.filter((user) => user.is_admin).length;

  const createUser = useMutation({
    mutationFn: api.createUser,
    onSuccess: async () => {
      setNewUsername("");
      setNewPassword("");
      setNewIsAdmin(false);
      setIsCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  const updateUser = useMutation({
    mutationFn: (body: { userId: number; data: UserUpdate }) =>
      api.updateUser(body.userId, body.data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  const resetPassword = useMutation({
    mutationFn: (body: { userId: number; password: string }) =>
      api.updateUser(body.userId, { password: body.password }),
    onSuccess: async () => {
      setResetTarget(null);
      setResetPasswordValue("");
      setResetError(null);
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  const deleteUser = useMutation({
    mutationFn: api.deleteUser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedUsername = newUsername.trim();
    if (!trimmedUsername || newPassword.length < 6) return;
    createUser.mutate({
      username: trimmedUsername,
      password: newPassword,
      is_admin: newIsAdmin,
      is_active: true,
    });
  };

  const patchUser = (user: UserAccount, data: UserUpdate) => {
    updateUser.mutate({ userId: user.id, data });
  };

  const openResetDialog = (user: UserAccount) => {
    resetPassword.reset();
    setResetError(null);
    setResetPasswordValue("");
    setResetTarget(user);
  };

  const closeResetDialog = () => {
    if (resetPassword.isPending) return;
    setResetTarget(null);
    setResetPasswordValue("");
    setResetError(null);
  };

  const handleResetSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetTarget || resetPasswordValue.length < 6) {
      setResetError(t("admin.passwordMin"));
      return;
    }
    setResetError(null);
    try {
      await resetPassword.mutateAsync({
        userId: resetTarget.id,
        password: resetPasswordValue,
      });
    } catch (error) {
      setResetError(error instanceof Error ? error.message : t("admin.resetError"));
    }
  };

  const handleDelete = async (user: UserAccount) => {
    const accepted = await confirm({
      title: t("admin.deleteTitle"),
      message: t("admin.deleteMessage", { username: user.username }),
      confirmLabel: t("confirm.delete"),
      danger: true,
    });
    if (!accepted) return;
    deleteUser.mutate(user.id);
  };

  return (
    <section className="admin-users" aria-label={t("admin.heading")}>
      <div className="projects-header admin-users-header">
        <div className="projects-heading-copy">
          <span className="projects-kicker">{t("admin.kicker")}</span>
          <h2>{t("admin.heading")}</h2>
          <div className="project-summary" aria-label={t("admin.summary")}>
            <span>
              <UsersRound size={15} aria-hidden />
              {t("admin.total", { count: userItems.length })}
            </span>
            <span>
              <CheckCircle2 size={15} aria-hidden />
              {t("admin.active", { count: activeCount })}
            </span>
            <span>
              <ShieldCheck size={15} aria-hidden />
              {t("admin.admins", { count: adminCount })}
            </span>
          </div>
        </div>
        {!isCreateOpen && (
          <button
            type="button"
            className="primary admin-users-create"
            onClick={() => setIsCreateOpen(true)}
          >
            <UserPlus size={16} aria-hidden />
            <span>{t("admin.create")}</span>
          </button>
        )}
      </div>

      {isCreateOpen && (
        <form className="admin-user-form" onSubmit={handleCreateSubmit}>
          <label htmlFor="admin-new-username">{t("admin.username")}</label>
          <input
            id="admin-new-username"
            autoFocus
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value)}
            placeholder={t("admin.usernamePlaceholder")}
          />

          <label htmlFor="admin-new-password">{t("admin.password")}</label>
          <div className="password-field">
            <KeyRound size={16} aria-hidden />
            <input
              id="admin-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={t("admin.passwordPlaceholder")}
            />
          </div>

          <label className="admin-check-row" htmlFor="admin-new-is-admin">
            <input
              id="admin-new-is-admin"
              type="checkbox"
              checked={newIsAdmin}
              onChange={(event) => setNewIsAdmin(event.target.checked)}
            />
            <span>{t("admin.makeAdmin")}</span>
          </label>

          {createUser.isError && (
            <p className="error small">{t("admin.createError")}</p>
          )}

          <div className="form-actions">
            <button
              type="submit"
              className="primary"
              disabled={
                !newUsername.trim() ||
                newPassword.length < 6 ||
                createUser.isPending
              }
            >
              {createUser.isPending ? (
                <LoaderCircle className="spin" size={16} aria-hidden />
              ) : (
                <UserPlus size={16} aria-hidden />
              )}
              <span>{t("admin.saveUser")}</span>
            </button>
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              disabled={createUser.isPending}
            >
              <X size={16} aria-hidden />
              <span>{t("confirm.cancel")}</span>
            </button>
          </div>
        </form>
      )}

      {users.isLoading && (
        <p className="project-state muted">{t("projects.loading")}</p>
      )}
      {users.isError && <p className="project-state error">{t("admin.error")}</p>}
      {updateUser.isError && (
        <p className="project-state error">{t("admin.updateError")}</p>
      )}
      {deleteUser.isError && (
        <p className="project-state error">{t("admin.deleteError")}</p>
      )}

      {users.data && userItems.length === 0 && (
        <div className="project-empty">
          <span className="project-empty-icon">
            <UsersRound size={26} aria-hidden />
          </span>
          <h3>{t("admin.emptyTitle")}</h3>
          <p>{t("admin.empty")}</p>
        </div>
      )}

      {users.data && userItems.length > 0 && (
        <div className="admin-user-list">
          {userItems.map((user) => {
            const isSelf = username === user.username;
            const isUpdating =
              updateUser.isPending && updateUser.variables?.userId === user.id;
            const isDeleting =
              deleteUser.isPending && deleteUser.variables === user.id;
            return (
              <article className="admin-user-row" key={user.id}>
                <div className="admin-user-main">
                  <span className="admin-user-avatar">
                    <UserCog size={18} aria-hidden />
                  </span>
                  <div className="admin-user-copy">
                    <div className="admin-user-title">
                      <strong>{user.username}</strong>
                      {isSelf && (
                        <span className="admin-user-pill self">
                          {t("admin.currentUser")}
                        </span>
                      )}
                      <span
                        className={
                          user.is_admin
                            ? "admin-user-pill admin"
                            : "admin-user-pill"
                        }
                      >
                        {user.is_admin ? t("admin.roleAdmin") : t("admin.roleUser")}
                      </span>
                      <span
                        className={
                          user.is_active
                            ? "admin-user-pill active"
                            : "admin-user-pill inactive"
                        }
                      >
                        {user.is_active ? t("admin.statusActive") : t("admin.statusInactive")}
                      </span>
                    </div>
                    <div className="admin-user-meta">
                      <span>{t("admin.createdAt")}: {formatTimestamp(user.created_at)}</span>
                      <span>{t("admin.updatedAt")}: {formatTimestamp(user.updated_at)}</span>
                    </div>
                  </div>
                </div>

                <div className="admin-user-controls">
                  <label className="admin-switch">
                    <input
                      type="checkbox"
                      checked={user.is_admin}
                      disabled={isSelf || isUpdating || deleteUser.isPending}
                      onChange={(event) =>
                        patchUser(user, { is_admin: event.target.checked })
                      }
                    />
                    <span>{t("admin.adminPermission")}</span>
                  </label>
                  <label className="admin-switch">
                    <input
                      type="checkbox"
                      checked={user.is_active}
                      disabled={isSelf || isUpdating || deleteUser.isPending}
                      onChange={(event) =>
                        patchUser(user, { is_active: event.target.checked })
                      }
                    />
                    <span>{t("admin.accountActive")}</span>
                  </label>
                  <button
                    type="button"
                    className="icon-btn admin-row-icon"
                    onClick={() => openResetDialog(user)}
                    disabled={isUpdating || deleteUser.isPending}
                    title={t("admin.resetPassword")}
                    aria-label={t("admin.resetPasswordFor", {
                      username: user.username,
                    })}
                  >
                    {isUpdating ? (
                      <LoaderCircle className="spin" size={16} aria-hidden />
                    ) : (
                      <KeyRound size={16} aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn admin-row-icon danger"
                    onClick={() => void handleDelete(user)}
                    disabled={isSelf || isUpdating || isDeleting}
                    title={t("admin.deleteUser")}
                    aria-label={t("admin.deleteUserFor", {
                      username: user.username,
                    })}
                  >
                    {isDeleting ? (
                      <LoaderCircle className="spin" size={16} aria-hidden />
                    ) : user.is_active ? (
                      <Trash2 size={16} aria-hidden />
                    ) : (
                      <Ban size={16} aria-hidden />
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {resetTarget && (
        <div
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("admin.resetPassword")}
          onMouseDown={closeResetDialog}
        >
          <form
            className="confirm-panel admin-reset-panel"
            onSubmit={handleResetSubmit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="confirm-close"
              type="button"
              onClick={closeResetDialog}
              disabled={resetPassword.isPending}
              aria-label={t("confirm.cancel")}
            >
              <X size={18} aria-hidden />
            </button>
            <div className="confirm-icon">
              <KeyRound size={22} aria-hidden />
            </div>
            <h3 className="confirm-title">{t("admin.resetPassword")}</h3>
            <p className="confirm-message">
              {t("admin.resetMessage", { username: resetTarget.username })}
            </p>
            <label className="sensitive-label" htmlFor="admin-reset-password">
              {t("admin.newPassword")}
            </label>
            <div className="password-field sensitive-password-field">
              <KeyRound size={16} aria-hidden />
              <input
                id="admin-reset-password"
                autoFocus
                type="password"
                autoComplete="new-password"
                value={resetPasswordValue}
                onChange={(event) => setResetPasswordValue(event.target.value)}
              />
            </div>
            {(resetError || resetPassword.isError) && (
              <p className="error small">
                {resetError ?? t("admin.resetError")}
              </p>
            )}
            <div className="confirm-actions">
              <button
                type="button"
                onClick={closeResetDialog}
                disabled={resetPassword.isPending}
              >
                {t("confirm.cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={resetPasswordValue.length < 6 || resetPassword.isPending}
              >
                {resetPassword.isPending
                  ? t("admin.saving")
                  : t("admin.resetPassword")}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
