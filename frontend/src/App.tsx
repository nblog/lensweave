/** Root layout and URL routes for the page flow in docs/04 §2. */
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Clapperboard,
  FolderKanban,
  Globe2,
  LogOut,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useMatch,
  useParams,
} from "react-router-dom";
import { useAuth } from "./auth/auth-context";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectPage } from "./pages/ProjectPage";
import { CanvasWorkshop } from "./pages/CanvasWorkshop";
import { GlobalAssetsPage } from "./pages/GlobalAssetsPage";
import { LoginPage } from "./pages/LoginPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import "./App.css";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/*" element={<ProtectedApp />} />
    </Routes>
  );
}

function LoginRoute() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const state = location.state as
    | { from?: { pathname?: string; search?: string } }
    | null;
  const from = state?.from;
  const destination =
    from?.pathname && from.pathname !== "/login"
      ? `${from.pathname}${from.search ?? ""}`
      : "/projects";

  if (isAuthenticated) return <Navigate to={destination} replace />;
  return <LoginPage />;
}

function ProtectedApp() {
  const { t } = useTranslation();
  const { isAuthenticated, isAdmin, logout, username } = useAuth();
  const location = useLocation();
  const projectMatch = useMatch("/projects/:projectUid");
  const workshopMatch = useMatch(
    "/projects/:projectUid/episodes/:episodeId/workshop",
  );

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const backTo = workshopMatch
    ? `/projects/${workshopMatch.params.projectUid}`
    : "/projects";
  const showBack = Boolean(projectMatch || workshopMatch);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" to="/projects" aria-label={t("app.title")}>
            <span className="brand-mark">
              <Clapperboard size={20} aria-hidden />
            </span>
            <span className="brand-copy">
              <h1>{t("app.title")}</h1>
              <p className="subtitle">{t("app.subtitle")}</p>
            </span>
          </Link>
          <div className="topbar-actions">
            <nav className="topnav" aria-label={t("nav.main")}>
              <NavLink
                to="/projects"
                className={({ isActive }) =>
                  isActive ? "navlink active" : "navlink"
                }
              >
                <FolderKanban size={16} aria-hidden />
                <span>{t("nav.projects")}</span>
              </NavLink>
              <NavLink
                to="/assets"
                className={({ isActive }) =>
                  isActive ? "navlink active" : "navlink"
                }
              >
                <Globe2 size={16} aria-hidden />
                <span>{t("nav.globalAssets")}</span>
              </NavLink>
              {isAdmin && (
                <NavLink
                  to="/admin/users"
                  className={({ isActive }) =>
                    isActive ? "navlink active" : "navlink"
                  }
                >
                  <UsersRound size={16} aria-hidden />
                  <span>{t("nav.users")}</span>
                </NavLink>
              )}
            </nav>
            <LanguageSwitcher />
            <div className="session-chip" aria-label={t("auth.session")}>
              <UserRound size={15} aria-hidden />
              <span>{username ?? t("auth.user")}</span>
              <button
                className="session-logout"
                type="button"
                onClick={logout}
                aria-label={t("auth.logout")}
                title={t("auth.logout")}
              >
                <LogOut size={15} aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className={workshopMatch ? "content content-wide" : "content"}>
        {showBack && (
          <Link className="back-btn" to={backTo}>
            <ArrowLeft size={16} aria-hidden />
            {t("app.back")}
          </Link>
        )}

        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/assets" element={<GlobalAssetsPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/projects/:projectUid" element={<ProjectRoute />} />
          <Route
            path="/projects/:projectUid/episodes/:episodeId/workshop"
            element={<WorkshopRoute />}
          />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function ProjectRoute() {
  const { projectUid } = useParams();
  if (!projectUid) return <Navigate to="/projects" replace />;
  return <ProjectPage projectUid={projectUid} />;
}

function WorkshopRoute() {
  const { projectUid, episodeId } = useParams();
  const parsedEpisodeId = parseRouteNumber(episodeId);
  if (!projectUid || parsedEpisodeId == null) {
    return <Navigate to="/projects" replace />;
  }
  return (
    <CanvasWorkshop projectUid={projectUid} episodeId={parsedEpisodeId} />
  );
}

function parseRouteNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export default App;
