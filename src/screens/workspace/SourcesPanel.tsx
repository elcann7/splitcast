import { useState } from "react";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { api } from "../../api";
import type { Source } from "../../api";
import { useT, errWith } from "../../i18n";
import { useApp } from "../../store/app";
import { Button, IconButton } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Input } from "../../ui/Fields";
import { fmtClock } from "../../lib/time";
import { currentSourceProgress } from "../../lib/sources";
import { useWorkspace } from "./ctx";

/** The project's videos: their state, renaming, re-scan, removal, and adding more. */
export function SourcesPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const { project, job, run, reload, addVideos } = useWorkspace();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const sources = project.sources;
  const rebuilding = !!project.activeJobId && sources.every((s) => s.status === "queued" || s.status === "analyzing");

  const status = (s: Source): { text: string; tone: string } => {
    if (s.sourceMissing) return { text: t("src.missing"), tone: "text-danger" };
    switch (s.status) {
      case "analyzing": {
        const p = s.progress ?? (job && job.sourceId === s.id ? currentSourceProgress(job) : 0);
        return { text: t("src.analyzing", { pct: Math.round(p * 100) }), tone: "text-fg-1" };
      }
      case "queued":
        return { text: t("src.queued"), tone: "text-fg-2" };
      case "failed":
        return { text: t("src.failed"), tone: "text-danger" };
      case "cancelled":
        return { text: t("src.cancelled"), tone: "text-fg-2" };
      default:
        return { text: t("src.ready"), tone: "text-fg-3" };
    }
  };

  async function commitName(s: Source) {
    const v = name.trim();
    setEditing(null);
    if (v && v !== s.label) await run(t("src.opErr"), () => api.patchSource(project.id, s.id, { label: v }));
  }

  async function rescan(s: Source) {
    setPending(s.id);
    try {
      await api.rescanSource(project.id, s.id);
      reload();
    } catch (e) {
      toast("error", errWith(t("src.opErr"), e));
    }
    setPending(null);
  }

  async function remove(s: Source) {
    setConfirmDel(null);
    setPending(s.id);
    await run(t("src.opErr"), () => api.deleteSource(project.id, s.id));
    setPending(null);
  }

  async function add() {
    try {
      const r = await api.openVideoDialog();
      if (r.paths.length) await addVideos(r.paths);
    } catch (e) {
      toast("error", errWith(t("src.addErr"), e));
    }
  }

  return (
    <Dialog
      title={t("src.panelTitle")}
      onClose={onClose}
      width={680}
      footer={
        <>
          <div className="mr-auto mono text-meta text-fg-2">{t("src.total", { n: sources.length, dur: fmtClock(project.duration) })}</div>
          <Button icon={<Plus size={16} strokeWidth={1.5} />} onClick={add} disabled={rebuilding}>
            {t("src.add")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      <div className="rounded-lg border border-line-strong bg-surface-2 divide-y divide-line max-h-[420px] overflow-y-auto">
        {sources.map((s, i) => {
          const st = status(s);
          const busy = s.status === "analyzing" || s.status === "queued" || pending === s.id;
          const detail = s.status === "failed" || s.sourceMissing ? s.error : (s.notice ?? null);
          return (
            <div key={s.id} className="px-3 py-2">
              <div className="flex items-center gap-3 min-h-8">
                <span className="mono text-meta text-fg-3 w-5 text-right shrink-0">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  {editing === s.id ? (
                    <Input
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={() => commitName(s)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitName(s);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="!h-7 text-body"
                    />
                  ) : (
                    <div
                      className="text-body truncate"
                      title={t("src.rename")}
                      onDoubleClick={() => {
                        setName(s.label);
                        setEditing(s.id);
                      }}
                    >
                      {s.label}
                    </div>
                  )}
                </div>
                <span className="mono text-meta text-fg-3 shrink-0 whitespace-nowrap">
                  {s.media.width}×{s.media.height} · {fmtClock(s.media.duration)}
                </span>
                <span className={`text-meta shrink-0 w-[132px] text-right ${st.tone}`}>{st.text}</span>
                <IconButton
                  size="sm"
                  disabled={busy || s.sourceMissing || rebuilding}
                  aria-label={s.status === "ready" ? t("src.rescan") : t("src.retry")}
                  title={s.status === "ready" ? t("src.rescan") : t("src.retry")}
                  onClick={() => rescan(s)}
                >
                  <RotateCw size={14} strokeWidth={1.5} />
                </IconButton>
                <IconButton
                  size="sm"
                  disabled={sources.length <= 1 || s.status === "analyzing" || pending === s.id || rebuilding}
                  aria-label={t("src.delete")}
                  title={sources.length <= 1 ? t("src.lastOne") : t("src.delete")}
                  onClick={() => setConfirmDel(s.id)}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </IconButton>
              </div>
              {detail && <div className="pl-8 pr-2 pb-1 text-meta text-fg-3 leading-snug break-words">{detail}</div>}
              {confirmDel === s.id && (
                <div className="pl-8 pr-1 pt-1 pb-1.5 flex items-start gap-3">
                  <div className="text-meta text-fg-2 leading-snug flex-1">{t("src.deleteBody", { label: s.label })}</div>
                  <Button size="sm" onClick={() => setConfirmDel(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove(s)}>
                    {t("src.delete")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
