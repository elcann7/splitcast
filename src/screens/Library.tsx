import { useCallback, useEffect, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { api } from "../api";
import type { ProjectSummary } from "../api";
import { useT, errWith } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Fields";
import { Menu } from "../ui/Menu";
import type { MenuItem } from "../ui/Menu";
import { ErrorState, StateMessage } from "../ui/States";
import { navigate, paths } from "../lib/router";
import { fmtClock } from "../lib/time";
import { useVideoDrop } from "../lib/useVideoDrop";
import { useJob } from "../lib/useJob";
import { NewProjectDialog } from "./NewProject";

export function Library({ newPaths }: { newPaths: string[] }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; p: ProjectSummary } | null>(null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // keep running analyses fresh
  const anyRunning = projects?.some((p) => p.status === "analyzing" || p.activeJobId);
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  const pickVideo = useCallback(async () => {
    try {
      const r = await api.openVideoDialog();
      if (r.paths.length) navigate(paths.newProject(r.paths));
    } catch (e) {
      toast("error", errWith(t("new.createErr"), e));
    }
  }, [t, toast]);

  // whole-window drop target; files dropped while the dialog is open join its list
  const dragging = useVideoDrop(
    (dropped) => navigate(paths.newProject([...newPaths, ...dropped]), newPaths.length > 0),
    pickVideo,
    false,
  );

  const menuItems = (p: ProjectSummary): MenuItem[] => [
    { label: t("common.open"), onClick: () => navigate(paths.project(p.id)) },
    { label: t("common.rename"), onClick: () => setRenaming(p) },
    { label: t("common.delete"), onClick: () => setDeleting(p), danger: true, separatorBefore: true },
  ];

  return (
    <div className="h-full flex flex-col relative">
      <header className="h-16 shrink-0 flex items-center justify-between px-8 border-b border-line">
        <div className="flex items-baseline gap-3">
          <h1 className="text-page font-semibold">{t("library.title")}</h1>
          {projects && projects.length > 0 && <span className="mono text-meta text-fg-3">{t("library.count", { n: projects.length })}</span>}
        </div>
        <Button variant="primary" icon={<Plus size={16} strokeWidth={1.75} />} onClick={pickVideo}>
          {t("library.new")}
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && !projects && (
          <ErrorState title={t("library.loadErrTitle")} body={t("library.loadErrBody")} onRetry={load} />
        )}
        {!error && !projects && (
          <div className="p-8 grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="anim-pulse" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="aspect-video rounded-lg bg-surface-1 border border-line" />
                <div className="mt-3 h-3.5 w-2/3 rounded bg-surface-2" />
                <div className="mt-2 h-3 w-1/2 rounded bg-surface-1" />
              </div>
            ))}
          </div>
        )}
        {projects && projects.length === 0 && (
          <div className="h-full p-8">
            <div className="h-full rounded-xl border border-dashed border-line-strong flex items-center justify-center">
              <StateMessage
                title={t("library.emptyText")}
                action={
                  <Button variant="primary" onClick={pickVideo}>
                    {t("library.pickVideo")}
                  </Button>
                }
              />
            </div>
          </div>
        )}
        {projects && projects.length > 0 && (
          <div className="p-8 grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {projects.map((p, i) => (
              <ProjectCard
                i={i}
                key={p.id}
                p={p}
                onOpen={() => navigate(paths.project(p.id))}
                onMenu={(x, y) => setMenu({ x, y, p })}
              />
            ))}
          </div>
        )}
      </div>

      {dragging && (
        <div className="absolute inset-0 z-40 bg-surface-0/90 p-4 anim-fade pointer-events-none">
          <div className="h-full rounded-xl border border-dashed border-fg-3 flex items-center justify-center text-section text-fg-1">
            {t("library.dropHere")}
          </div>
        </div>
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.p)} onClose={() => setMenu(null)} />}
      {newPaths.length > 0 && <NewProjectDialog paths={newPaths} onClose={() => navigate(paths.library())} />}
      {renaming && (
        <RenameDialog
          project={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            load();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title={t("library.deleteTitle")}
          onClose={() => setDeleting(null)}
          width={440}
          footer={
            <>
              <Button onClick={() => setDeleting(null)} data-autofocus>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const p = deleting;
                  setDeleting(null);
                  try {
                    await api.deleteProject(p.id);
                    load();
                  } catch (e) {
                    toast("error", errWith(t("ws.actionErr"), e));
                  }
                }}
              >
                {t("common.delete")}
              </Button>
            </>
          }
        >
          <p className="text-fg-2 leading-relaxed">{t("library.deleteBody", { title: deleting.title })}</p>
        </Dialog>
      )}
    </div>
  );
}

function RenameDialog({ project, onClose, onDone }: { project: ProjectSummary; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [v, setV] = useState(project.title);
  const submit = async () => {
    const title = v.trim();
    if (!title || title === project.title) return onClose();
    try {
      await api.renameProject(project.id, title);
      onDone();
    } catch (e) {
      toast("error", errWith(t("ws.renameErr"), e));
      onClose();
    }
  };
  return (
    <Dialog
      title={t("library.renameTitle")}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={!v.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Input
        data-autofocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Dialog>
  );
}

function ProjectCard({ p, i, onOpen, onMenu }: { p: ProjectSummary; i: number; onOpen: () => void; onMenu: (x: number, y: number) => void }) {
  const t = useT();
  const multi = p.sourceCount > 1;
  const pending = p.readySourceCount < p.sourceCount;
  // a ready project can still have sources analysing behind it
  const { job } = useJob(p.status === "analyzing" || (pending && p.activeJobId) ? p.activeJobId : null);
  const pct = Math.round((job?.progress ?? 0) * 100);
  const presetName = t(`preset.${p.preset}` as const);
  const working = (p.status === "analyzing" || (p.status === "ready" && !!p.activeJobId && pending)) && job?.status !== "failed";

  let meta: string;
  let danger = false;
  if (p.status === "analyzing") {
    meta = multi ? t("library.analyzingMulti", { ready: p.readySourceCount, total: p.sourceCount, pct }) : t("library.analyzing", { pct });
  } else if (p.status === "failed") {
    meta = t("library.failed");
    danger = true;
  } else if (p.status === "cancelled") meta = t("library.cancelled");
  else if (multi) {
    const head = pending ? t("library.partial", { ready: p.readySourceCount, total: p.sourceCount }) : t("common.videoCount", { n: p.sourceCount });
    meta = `${head} · ${fmtClock(p.duration)} · ${t("library.charCount", { n: p.characterCount })}`;
  } else meta = `${fmtClock(p.duration)} · ${t("library.charCount", { n: p.characterCount })} · ${presetName}`;

  return (
    <div
      className="group relative anim-rise"
      style={{ "--i": i } as React.CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button onClick={onOpen} className="block w-full text-left rounded-lg" aria-label={p.title}>
        <div className="relative aspect-video rounded-lg overflow-hidden bg-surface-1 border border-line group-hover:border-fg-3 group-hover:-translate-y-0.5 t-fast">
          {p.poster && (
            <img
              src={p.poster}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={(e) => (e.currentTarget.dataset.loaded = "1")}
              className="img-fade absolute inset-0 w-full h-full object-cover group-hover:scale-[1.04]"
            />
          )}
          {working && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div className="h-full bg-accent progress-live" style={{ width: `${pct}%`, transition: "width 400ms linear" }} />
            </div>
          )}
        </div>
        <div className="mt-2.5 px-0.5">
          <div className="text-body font-medium truncate" title={p.title}>
            {p.title}
          </div>
          <div className={`mono text-meta mt-0.5 truncate ${danger ? "text-danger" : "text-fg-2"}`}>{meta}</div>
        </div>
      </button>
      <button
        aria-label="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom + 4);
        }}
        className="absolute top-2 right-2 h-7 w-7 rounded bg-black/60 text-fg-1 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/80 t-fast"
      >
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
