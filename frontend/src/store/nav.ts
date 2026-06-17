/** Minimal navigation store (Zustand). The slice has three views — projects,
 * one project, and an episode workshop — so a router is overkill; we track the
 * current view and the selected ids here. Routing arrives with more pages. */
import { create } from "zustand";

export type View =
  | { name: "projects" }
  | { name: "assets" }
  | { name: "project"; projectId: number }
  | { name: "workshop"; projectId: number; episodeId: number };

interface NavState {
  view: View;
  goProjects: () => void;
  goAssets: () => void;
  goProject: (projectId: number) => void;
  goWorkshop: (projectId: number, episodeId: number) => void;
}

export const useNav = create<NavState>((set) => ({
  view: { name: "projects" },
  goProjects: () => set({ view: { name: "projects" } }),
  goAssets: () => set({ view: { name: "assets" } }),
  goProject: (projectId) => set({ view: { name: "project", projectId } }),
  goWorkshop: (projectId, episodeId) =>
    set({ view: { name: "workshop", projectId, episodeId } }),
}));
