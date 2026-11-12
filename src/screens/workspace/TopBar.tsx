import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Film } from "lucide-react";
import { api } from "../../api";
import type { Project } from "../../api";
import { useT, errWith } from "../../i18n";
import { useApp } from "../../store/app";
import { Button } from "../../ui/Button";
import { navigate, paths } from "../../lib/router";
import { fmtClock } from "../../lib/time";
import { useWorkspace } from "./ctx";

export function TopBar({ onProject, onOpenSources }: { onProject: (p: Project) => void; onOpenSources: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const { project, selected } = useWorkspace();
  const [title, setTitle] = useState(project.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const sources = project.sources;

  useEffect(() => setTitle(project.title), [project.title]);

  async function commit() {
    const v = title.trim();
    if (!v || v === project.title) {
      setTitle(project.title);
      return;
    }
    try {
      onProject(await api.renameProject(project.id, v));
    } catch (e) {
      setTitle(project.title);
      toast("error", errWith(t("ws.renameErr"), e));
    }
  }

  const n = selected.size;
  const one = sources.length === 1 ? sources[0].media : null;
  const facts = one
    ? `${one.width}×${one.height} · ${+one.fps.toFixed(3)} fps · ${fmtClock(one.duration)} · ${one.videoCodec}`
    : t("ws.videosDur", { n: sources.length, dur: fmtClock(project.duration) });
  const anyMissing = sources.some((s) => s.sourceMissing);
  const busy = !!project.activeJobId;

  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-3 border-b border-line bg-surface-1">
      <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} strokeWidth={1.5} />} onClick={() => navigate(paths.library())}>
        {t("ws.back")}
      </Button>
      <div className="h-4 w-px bg-line" />
      <input
        ref={inputRef}
        value={title}
        placeholder={t("ws.titlePlaceholder")}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.blur();
          if (e.key === "Escape") {
            setTitle(project.title);
            requestAnimationFrame(() => inputRef.current?.blur());
          }
        }}
        spellCheck={false}
        size={Math.min(40, Math.max(12, title.length + 1))}
        className="h-8 min-w-[120px] max-w-[340px] rounded px-2 -mx-2 bg-transparent text-body font-medium truncate border border-transparent hover:border-line-strong focus:border-fg-3 focus:bg-surface-2 t-fast"
      />
      <div className="mono text-meta text-fg-3 truncate min-w-0" title={one?.path}>
        {facts}
      </div>
      <div className="flex-1" />
      <Button icon={<Film size={16} strokeWidth={1.5} />} onClick={onOpenSources}>
        {t("ws.videosN", { n: sources.length })}
      </Button>
      <Button
        onClick={() => navigate(paths.project(project.id) + "/rescan")}
        disabled={anyMissing || busy}
        title={anyMissing ? t("ws.sourceMissingTitle") : undefined}
      >
        {t("ws.rescan")}
      </Button>
      <Button variant="primary" disabled={n === 0} title="Ctrl+E" onClick={() => navigate(paths.project(project.id) + "/export")}>
        <span key={n} className="anim-bump">
          {t("ws.export", { n })}
        </span>
      </Button>
    </header>
  );
}
