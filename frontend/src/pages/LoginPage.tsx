import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Clapperboard,
  Film,
  KeyRound,
  LockKeyhole,
  LogIn,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/auth-context";

interface LoginLocationState {
  from?: {
    pathname?: string;
    search?: string;
  };
}

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as LoginLocationState | null)?.from;
  const destination =
    from?.pathname && from.pathname !== "/login"
      ? `${from.pathname}${from.search ?? ""}`
      : "/projects";

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(false);
    try {
      await login(username.trim(), password);
      navigate(destination, { replace: true });
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-shell">
        <section className="login-visual" aria-labelledby="login-visual-title">
          <div className="login-visual-head">
            <span className="login-product-mark">
              <Clapperboard size={26} aria-hidden />
            </span>
            <div>
              <span className="login-eyebrow">{t("auth.entry")}</span>
              <h1 id="login-visual-title">{t("app.title")}</h1>
            </div>
          </div>
          <p className="login-visual-copy">{t("auth.tagline")}</p>
          <div className="login-preview-board" aria-hidden>
            <div className="login-preview-top">
              <span />
              <span />
              <span />
            </div>
            <div className="login-preview-main">
              <div className="login-preview-rail">
                <span className="active" />
                <span />
                <span />
              </div>
              <div className="login-preview-stage">
                <span className="login-preview-kicker" />
                <span className="login-preview-title" />
                <div className="login-preview-strip">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="login-preview-grid">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>
          <div className="login-visual-status">
            <span>
              <Sparkles size={15} aria-hidden />
              {t("auth.ready")}
            </span>
            <span>
              <ShieldCheck size={15} aria-hidden />
              {t("auth.secure")}
            </span>
          </div>
        </section>

        <section className="login-panel" aria-labelledby="login-title">
          <div className="login-brand">
            <span className="login-mark">
              <ShieldCheck size={24} aria-hidden />
            </span>
            <div>
              <span className="login-eyebrow">{t("auth.account")}</span>
              <h2 id="login-title">{t("auth.title")}</h2>
              <p>{t("auth.subtitle")}</p>
            </div>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="login-username">{t("auth.username")}</label>
              <div className="login-input-shell">
                <UserRound size={16} aria-hidden />
                <input
                  id="login-username"
                  autoComplete="username"
                  value={username}
                  placeholder={t("auth.usernamePlaceholder")}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
            </div>

            <div className="login-field">
              <label htmlFor="login-password">{t("auth.password")}</label>
              <div className="password-field login-input-shell">
                <LockKeyhole size={16} aria-hidden />
                <input
                  id="login-password"
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  placeholder={t("auth.passwordPlaceholder")}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </div>

            {error && <p className="error small">{t("auth.loginError")}</p>}

            <button
              type="submit"
              className="primary login-submit"
              disabled={!username.trim() || !password || submitting}
            >
              {submitting ? (
                <Film size={16} aria-hidden />
              ) : (
                <LogIn size={16} aria-hidden />
              )}
              <span>{submitting ? t("auth.loggingIn") : t("auth.login")}</span>
            </button>
          </form>
          <div className="login-footnote">
            <KeyRound size={14} aria-hidden />
            <span>{t("auth.localAccount")}</span>
          </div>
        </section>
      </div>
    </main>
  );
}
