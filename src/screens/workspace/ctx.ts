import { createContext, useContext } from "react";
import type { Appearance, Character, Job, Project } from "../../api";
import type { Filters, Trim } from "../../store/workspace";

/** Imperative handles the inspector registers so global keys can reach the player. */
export interface InspectorHandle {
  toggle: () => void;
  markIn: () => void;
  markOut: () => void;
}

export interface Ctx {
  project: Project;
  /** the analysis job still working on this project's videos, if any */
  job: Job | null;
  /** fetch the project again (after something changed on the backend side) */
  reload: () => void;
  /** add video files to this project and queue them for analysis */
  addVideos: (paths: string[]) => Promise<void>;
  /** the character whose scenes are shown */
  char: Character | null;
  /** char's appearances after filters and sort */
  list: Appearance[];
  selected: ReadonlySet<string>;
  focusId: string | null;
  trims: Record<string, Trim>;
  filters: Filters;
  /** cols of the scene grid, written by the grid, read by arrow-key navigation */
  colsRef: { current: number };
  inspector: { current: InspectorHandle | null };
  /** send an updated Project from the backend into the app and reconcile local state */
  applyProject: (p: Project) => void;
  /** run a mutating call; toasts a plain-language error and returns false on failure */
  run: (what: string, fn: () => Promise<Project>) => Promise<boolean>;
  setCurrent: (cid: string) => void;
  setSelection: (ids: Iterable<string>, cid?: string) => void;
  focusAppearance: (id: string | null, scroll?: "nearest" | "center" | null) => void;
  setTrim: (aid: string, trim: Trim | null) => void;
  openMove: (ids: string[]) => void;
  /** monotonically increasing request to scroll the grid to a scene */
  scrollReq: { id: string; n: number; center: boolean } | null;
  resetFilters: () => void;
}

export const WorkspaceCtx = createContext<Ctx | null>(null);

export function useWorkspace(): Ctx {
  const c = useContext(WorkspaceCtx);
  if (!c) throw new Error("WorkspaceCtx missing");
  return c;
}
