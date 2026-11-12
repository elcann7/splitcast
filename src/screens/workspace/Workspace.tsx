import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOCK, api } from "../../api";
import type { Appearance, Project } from "../../api";
import { useT, errWith } from "../../i18n";
import { useApp } from "../../store/app";
import { DEFAULT_FILTERS, selectedOf, sessionOf, useWS } from "../../store/workspace";
import type { Trim } from "../../store/workspace";
import { navigate, paths } from "../../lib/router";
import { WorkspaceCtx } from "./ctx";
import type { Ctx, InspectorHandle } from "./ctx";
import { TopBar } from "./TopBar";
import { CastPanel } from "./CastPanel";
import { Scenes } from "./Scenes";
import { Inspector } from "./Inspector";
import { MoveDialog } from "./MoveDialog";
import { ExportDialog } from "../ExportDialog";
import { RescanDialog } from "../RescanDialog";
import { SourcesPanel } from "./SourcesPanel";
import { Button } from "../../ui/Button";
import { Progress } from "../../ui/States";
import { useJob } from "../../lib/useJob";
import { useVideoDrop } from "../../lib/useVideoDrop";
import { currentSourceProgress } from "../../lib/sources";
import { TriangleAlert } from "lucide-react";

interface Props {
  project: Project;
  setProject: (p: Project) => void;
  reload: () => void;
  dialog: "export" | "rescan" | null;
  query: URLSearchParams;
}

function defaultChar(p: Project): string | null {
  return (p.characters.find((c) => !c.hidden && !c.isMinor) ?? p.characters.find((c) => !c.hidden) ?? p.characters[0])?.id ?? null;
}

export function Workspace({ project, setProject, reload, dialog, query }: Props) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const pid = project.id;

  const sess = useWS((s) => sessionOf(s, pid));
  const filters = useWS((s) => s.filters);
  const { setCurrent, setSelection, setFocus, setTrim, reconcile } = useWS.getState();

  const curId = sess.currentChar && project.characters.some((c) => c.id === sess.currentChar) ? sess.currentChar : defaultChar(project);
  const char = project.characters.find((c) => c.id === curId) ?? null;

  const srcFilter = filters.source !== "all" && project.sources.some((s) => s.id === filters.source) ? filters.source : null;
  const list = useMemo(() => {
    if (!char) return [] as Appearance[];
    let l = char.appearances.filter(
      (a) =>
        (srcFilter === null || a.sourceId === srcFilter) &&
        (filters.size === "all" || a.shotSize === filters.size) &&
        (!filters.solo || a.solo) &&
        a.end - a.start >= filters.minDur,
    );
    if (filters.sort === "duration") l = [...l].sort((a, b) => b.end - b.start - (a.end - a.start));
    else if (filters.sort === "confidence") l = [...l].sort((a, b) => b.confidence - a.confidence);
    return l;
  }, [char, filters, srcFilter]);

  const selected = selectedOf(sess, curId);
  const focusId = curId ? (sess.focus[curId] ?? null) : null;
  // keep the focus valid when filters change
  const focusValid = focusId && char?.appearances.some((a) => a.id === focusId) ? focusId : null;

  const colsRef = useRef(4);
  const inspector = useRef<InspectorHandle | null>(null);
  const [scrollReq, setScrollReq] = useState<Ctx["scrollReq"]>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const reqN = useRef(0);
  const [showSources, setShowSources] = useState(false);
  const [stopping, setStopping] = useState(false);
  const { job: liveJob } = useJob(project.activeJobId);
  const job = liveJob && (liveJob.status === "queued" || liveJob.status === "running") ? liveJob : null;

  // Data refreshed underneath the user (a video finished analysing) must not lose their work:
  // selection, trims and focus are carried over, and a merged character is followed.
  const prevProject = useRef<Project | null>(null);
  useEffect(() => {
    reconcile(project, prevProject.current);
    prevProject.current = project;
  }, [project, reconcile]);

  // a video finished (or the whole job did): fetch what it added
  const jobMark = liveJob ? `${liveJob.id}:${liveJob.sourceIndex}:${liveJob.status}` : "";
  const lastMark = useRef("");
  useEffect(() => {
    if (jobMark && lastMark.current && jobMark !== lastMark.current) reload();
    lastMark.current = jobMark;
    if (!job) setStopping(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobMark]);

  const addVideos = useCallback(
    async (paths: string[]) => {
      try {
        const r = await api.addSources(pid, paths);
        toast("info", r.sourceIds.length ? t("src.added", { n: r.sourceIds.length }) : t("src.dup"));
        reload();
      } catch (e) {
        toast("error", errWith(t("src.addErr"), e));
      }
    },
    [pid, reload, toast, t],
  );
  const dragging = useVideoDrop(addVideos, () => setShowSources(true));
  const missing = project.sources.filter((s) => s.sourceMissing);

  const applyProject = useCallback(
    (p: Project) => {
      setProject(p);
      reconcile(p);
    },
    [setProject, reconcile],
  );

  const run = useCallback(
    async (what: string, fn: () => Promise<Project>) => {
      try {
        applyProject(await fn());
        return true;
      } catch (e) {
        toast("error", errWith(what, e));
        return false;
      }
    },
    [applyProject, toast],
  );

  const focusAppearance = useCallback(
    (id: string | null, scroll: "nearest" | "center" | null = null) => {
      if (!curId) return;
      setFocus(pid, curId, id);
      if (id && scroll) setScrollReq({ id, n: ++reqN.current, center: scroll === "center" });
    },
    [curId, pid, setFocus],
  );

  const ctx: Ctx = {
    project,
    job,
    reload,
    addVideos,
    char,
    list,
    selected,
    focusId: focusValid,
    trims: sess.trims,
    filters,
    colsRef,
    inspector,
    applyProject,
    run,
    setCurrent: (cid) => setCurrent(pid, cid),
    setSelection: (ids, cid) => {
      const k = cid ?? curId;
      if (k) setSelection(pid, k, ids);
    },
    focusAppearance,
    setTrim: (aid: string, trim: Trim | null) => setTrim(pid, aid, trim),
    openMove: setMoveIds,
    scrollReq,
    resetFilters: () => useWS.getState().setFilters(DEFAULT_FILTERS),
  };

  // ---- mock-only deep links for design review: ?sel=8&focus=3&char=1 in the hash query
  const demoDone = useRef(false);
  useEffect(() => {
    if (demoDone.current) return;
    demoDone.current = true;
    if (MOCK) {
      const ci = Number(query.get("char") ?? NaN);
      const c = Number.isFinite(ci) ? project.characters[ci] : null;
      if (c) setCurrent(pid, c.id);
      const target = c ?? project.characters.find((x) => x.id === curId);
      if (target) {
        const sel = Number(query.get("sel") ?? 0);
        if (sel > 0) setSelection(pid, target.id, target.appearances.filter((_, i) => i % 3 === 0).slice(0, sel).map((a) => a.id));
        const f = query.get("focus");
        if (f !== null && target.appearances[Number(f)]) setFocus(pid, target.id, target.appearances[Number(f)].id);
      }
    }
    if (!sess.currentChar && curId) setCurrent(pid, curId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- global keyboard
  const stateRef = useRef({ ctx, dialog });
  stateRef.current = { ctx, dialog };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
      if (document.querySelector("[data-dialog]") || document.querySelector("[role=menu]")) return;
      const { ctx: c } = stateRef.current;
      const inCast = !!el.closest("[data-cast]");
      const idx = c.focusId ? c.list.findIndex((a) => a.id === c.focusId) : -1;
      const go = (i: number) => {
        if (!c.list.length) return;
        const n = Math.max(0, Math.min(c.list.length - 1, i));
        c.focusAppearance(c.list[n].id, "nearest");
      };
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (key === "a") {
          e.preventDefault();
          c.setSelection(c.list.map((a) => a.id).concat([...c.selected].filter((id) => !c.list.some((a) => a.id === id))));
        } else if (key === "e" && c.selected.size > 0) {
          e.preventDefault();
          navigate(paths.project(c.project.id) + "/export");
        }
        return;
      }
      if (e.altKey) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          c.inspector.current?.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          go(idx < 0 ? 0 : idx - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(idx < 0 ? 0 : idx + 1);
          break;
        case "ArrowUp":
          if (inCast) return;
          e.preventDefault();
          go(idx < 0 ? 0 : idx - c.colsRef.current);
          break;
        case "ArrowDown":
          if (inCast) return;
          e.preventDefault();
          go(idx < 0 ? 0 : idx + c.colsRef.current);
          break;
        case "Home":
          if (inCast) return;
          e.preventDefault();
          go(0);
          break;
        case "End":
          if (inCast) return;
          e.preventDefault();
          go(c.list.length - 1);
          break;
        case "Enter":
          if (inCast || !c.focusId) return;
          e.preventDefault();
          {
            const next = new Set(c.selected);
            if (next.has(c.focusId)) next.delete(c.focusId);
            else next.add(c.focusId);
            c.setSelection(next);
          }
          break;
        case "Escape":
          if (c.selected.size) c.setSelection([]);
          break;
        default:
          if (key === "i") c.inspector.current?.markIn();
          else if (key === "o") c.inspector.current?.markOut();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeDialog = () => navigate(paths.project(pid));

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <div className="relative h-full flex flex-col bg-surface-0 anim-fade">
        <TopBar onProject={setProject} onOpenSources={() => setShowSources(true)} />
        {job && (
          <div className="shrink-0 flex items-center gap-3 h-8 px-4 border-b border-line bg-surface-1">
            <div className="mono text-meta text-fg-2 truncate min-w-0">
              {job.sourceId
                ? t("strip.analyzing", {
                    i: job.sourceIndex,
                    n: job.sourceCount,
                    label: project.sources.find((s) => s.id === job.sourceId)?.label ?? "",
                    pct: Math.round(currentSourceProgress(job) * 100),
                  })
                : t("strip.starting")}
            </div>
            <Progress value={job.progress} className="w-40 shrink-0" />
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => setShowSources(true)}>
              {t("strip.open")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                try {
                  await api.cancelJob(job.id);
                } catch (e) {
                  setStopping(false);
                  toast("error", errWith(t("ws.actionErr"), e));
                }
              }}
            >
              {stopping ? t("strip.stopping") : t("strip.stop")}
            </Button>
          </div>
        )}
        {missing.length > 0 && (
          <div className="shrink-0 flex items-start gap-3 px-4 py-2.5 border-b border-line bg-surface-1">
            <TriangleAlert size={16} strokeWidth={1.5} className="text-fg-2 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-body font-medium">
                {project.sources.length === 1 ? t("ws.sourceMissingTitle") : t("ws.someMissingTitle", { n: missing.length })}
              </div>
              <div className="text-meta text-fg-2 leading-snug break-words">
                {project.sources.length === 1
                  ? t("ws.sourceMissingBody", { path: missing[0].media.path })
                  : t("ws.someMissingBody", { labels: missing.map((s) => s.label).join(", ") })}
              </div>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 flex">
          <CastPanel />
          <Scenes />
          <Inspector />
        </div>
      </div>
      {dragging && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-surface-0/85 pointer-events-none">
          <div className="rounded-lg border border-accent bg-surface-1 px-6 py-4 text-section font-medium">{t("ws.dropAdd")}</div>
        </div>
      )}
      {showSources && <SourcesPanel onClose={() => setShowSources(false)} />}
      {moveIds && <MoveDialog ids={moveIds} onClose={() => setMoveIds(null)} />}
      {dialog === "export" && <ExportDialog onClose={closeDialog} />}
      {dialog === "rescan" && <RescanDialog project={project} onClose={closeDialog} onStarted={reload} />}
    </WorkspaceCtx.Provider>
  );
}
