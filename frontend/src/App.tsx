/** Root layout: top bar with title, nav (projects / asset library), and language
 * switcher; a view switch driven by the nav store (docs/04 §2). A real router
 * arrives with more pages. */
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectPage } from "./pages/ProjectPage";
import { AssetLibraryPage } from "./pages/AssetLibraryPage";
import { CanvasWorkshop } from "./pages/CanvasWorkshop";
import { useNav } from "./store/nav";
import "./App.css";

function App() {
  const { t } = useTranslation();
  const view = useNav((s) => s.view);
  const goProjects = useNav((s) => s.goProjects);
  const goAssets = useNav((s) => s.goAssets);
  const goProject = useNav((s) => s.goProject);

  const isWorkshop = view.name === "workshop";
  // Active top-level tab (project/workshop both fall under "projects").
  const activeTab = view.name === "assets" ? "assets" : "projects";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>{t("app.title")}</h1>
          <p className="subtitle">{t("app.subtitle")}</p>
        </div>
        <nav className="topnav">
          <button
            className={activeTab === "projects" ? "navlink active" : "navlink"}
            onClick={goProjects}
          >
            {t("nav.projects")}
          </button>
          <button
            className={activeTab === "assets" ? "navlink active" : "navlink"}
            onClick={goAssets}
          >
            {t("nav.assets")}
          </button>
        </nav>
        <LanguageSwitcher />
      </header>

      <main className={isWorkshop ? "content content-wide" : "content"}>
        {(view.name === "project" || view.name === "workshop") && (
          <button
            className="back-btn"
            onClick={() =>
              view.name === "workshop"
                ? goProject(view.projectId)
                : goProjects()
            }
          >
            {t("app.back")}
          </button>
        )}

        {view.name === "projects" && <ProjectsPage />}
        {view.name === "assets" && <AssetLibraryPage />}
        {view.name === "project" && <ProjectPage projectId={view.projectId} />}
        {view.name === "workshop" && (
          <CanvasWorkshop projectId={view.projectId} episodeId={view.episodeId} />
        )}
      </main>
    </div>
  );
}

export default App;
