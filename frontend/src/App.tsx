/** Root layout and URL routes for the page flow in docs/04 §2. */
import { useTranslation } from "react-i18next";
import { ArrowLeft, Clapperboard, FolderKanban, Globe2 } from "lucide-react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useMatch,
  useParams,
} from "react-router-dom";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectPage } from "./pages/ProjectPage";
import { CanvasWorkshop } from "./pages/CanvasWorkshop";
import { GlobalAssetsPage } from "./pages/GlobalAssetsPage";
import "./App.css";

function App() {
  const { t } = useTranslation();
  const projectMatch = useMatch("/projects/:projectUid");
  const workshopMatch = useMatch(
    "/projects/:projectUid/episodes/:episodeId/workshop",
  );

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
            </nav>
            <LanguageSwitcher />
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
