import { useMemo, useState } from "react";
import { estimateExportSec, fmtEstimate } from "../lib/exportEstimate";
import { ENCODER_NAME } from "../lib/encoder";
import { Check } from "lucide-react";
import { api } from "../api";
import type { ExportOptionsT, ExportRequest } from "../api";
import { useT, errWith } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Fields";
import { Progress } from "../ui/States";
import { ExportOptions } from "./ExportOptions";
import { useJob } from "../lib/useJob";
import { fmtClock } from "../lib/time";
import { mediaDiffs } from "../lib/sources";
import { useWorkspace } from "./workspace/ctx";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const system = useApp((s) => s.system);
  const { project, char, selected, trims } = useWorkspace();

  const [opts, setOpts] = useState<ExportOptionsT>(
    settings?.export ?? { mode: "clips", codec: "h264", quality: "high", audio: true, paddingMs: 200, joinAdjacent: true },
  );
  const [dir, setDir] = useState(settings?.exportDir || system?.paths.defaultExportDir || "");
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { job, lost } = useJob(jobId);

  const picked = useMemo(() => (char ? char.appearances.filter((a) => selected.has(a.id)) : []), [char, selected]);
  // scenes of a video whose file is gone cannot be cut; they are left out and counted
  const gone = useMemo(() => new Set(project.sources.filter((s) => s.sourceMissing).map((s) => s.id)), [project.sources]);
  const items = useMemo(() => picked.filter((a) => !gone.has(a.sourceId)), [picked, gone]);
  const skipped = picked.length - items.length;
  const involved = useMemo(() => {
    const ids = new Set(items.map((a) => a.sourceId));
    return project.sources.filter((s) => ids.has(s.id));
  }, [items, project.sources]);
  const diffs = useMemo(() => mediaDiffs(involved.map((s) => s.media)), [involved]);
  const totalSec = items.reduce((s, a) => {
    const tr = trims[a.id];
    return s + (tr ? tr.end - tr.start : a.end - a.start);
  }, 0);

  async function start() {
    if (!char || !items.length) return;
    const tr: ExportRequest["trims"] = {};
    for (const a of items) if (trims[a.id]) tr[a.id] = trims[a.id];
    setStarting(true);
    try {
      const r = await api.startExport(project.id, {
        characterId: char.id,
        appearanceIds: items.map((a) => a.id),
        trims: tr,
        ...opts,
        outputDir: dir,
      });
      setJobId(r.jobId);
    } catch (e) {
      toast("error", errWith(t("export.startErr"), e));
    }
    setStarting(false);
  }

  const phase = !jobId ? "options" : !job || job.status === "queued" || job.status === "running" ? "running" : job.status;
  const encoder = system?.ffmpeg.encoder ?? null;
  const merged = opts.mode === "merged";
  const blocked = merged && opts.codec === "copy" && diffs.length > 0;
  const conforms = merged && opts.codec !== "copy" && (diffs.includes("size") || diffs.includes("fps"));
  const vids = `${involved.length} video`;
  const encodes = opts.codec === "h264" || opts.codec === "hevc";
  const estimate = fmtEstimate(
    estimateExportSec({ codec: opts.codec, quality: opts.quality, merged, nvenc: !!encoder, clips: items.length, pictureSec: totalSec }),
    { h: t("unit.h"), min: t("unit.min"), sec: t("unit.sec") },
  );
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  const target = `${dir.replace(/[\\/]+$/, "")}${sep}${project.title}${sep}${char?.name ?? ""}${sep}`;

  // ---------- progress views
  if (phase !== "options") {
    const files = job?.result?.files ?? [];
    return (
      <Dialog
        title={t("export.title")}
        onClose={onClose}
        width={560}
        dismissable={phase !== "running"}
        hideClose={phase === "running"}
        footer={
          phase === "running" ? (
            <Button
              disabled={cancelling}
              onClick={async () => {
                if (!jobId) return;
                setCancelling(true);
                try {
                  await api.cancelJob(jobId);
                } catch (e) {
                  toast("error", errWith(t("ws.actionErr"), e));
                }
                setCancelling(false);
              }}
            >
              {t("export.cancelExport")}
            </Button>
          ) : phase === "done" ? (
            <>
              <Button onClick={onClose}>{t("common.close")}</Button>
              <Button
                variant="primary"
                data-autofocus
                onClick={() =>
                  api.openPath(job?.result?.outputDir ?? dir).catch((e) => toast("error", errWith(t("ws.actionErr"), e)))
                }
              >
                {t("export.openFolder")}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t("common.close")}</Button>
              <Button onClick={() => setJobId(null)}>{t("export.back")}</Button>
            </>
          )
        }
      >
        {phase === "running" && (
          <div className="flex flex-col gap-3 py-2">
            <div className="text-section font-medium">{t("export.running")}</div>
            <Progress value={job?.progress ?? 0} />
            <div className="flex items-center gap-5 mono text-meta text-fg-2 h-4">
              {lost ? (
                <span className="text-danger">{t("err.network")}</span>
              ) : (
                <>
                  <span className="text-fg-1">{Math.round((job?.progress ?? 0) * 100)}%</span>
                  {job?.message && <span>{job.message}</span>}
                  {job?.etaSeconds != null && <span className="ml-auto">{t("export.eta", { eta: fmtClock(job.etaSeconds) })}</span>}
                </>
              )}
            </div>
          </div>
        )}
        {phase === "done" && (
          <div className="flex flex-col gap-3 py-1">
            <div className="flex items-center gap-2 text-section font-medium">
              <Check size={18} strokeWidth={2} className="text-ok" />
              {t("export.doneTitle")}
            </div>
            <div className="text-fg-2">{t("export.doneBody", { n: files.length || items.length })}</div>
            {(job?.result?.skipped ?? 0) > 0 && <div className="text-meta text-fg-3">{t("export.skippedNote", { n: job?.result?.skipped ?? 0 })}</div>}
            <div className="mono text-meta text-fg-1 break-all rounded-lg border border-line bg-surface-2 px-3 py-2 select-text">
              {job?.result?.outputDir ?? dir}
            </div>
          </div>
        )}
        {phase === "failed" && (
          <div className="flex flex-col gap-3 py-1">
            <div className="text-section font-medium">{t("export.failedTitle")}</div>
            <pre className="mono text-meta text-fg-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 px-3 py-2 select-text">
              {job?.error ?? t("analysis.noErrorText")}
            </pre>
          </div>
        )}
        {phase === "cancelled" && (
          <div className="flex flex-col gap-2 py-1">
            <div className="text-section font-medium">{t("export.cancelledTitle")}</div>
            <div className="text-fg-2">{t("export.cancelledBody")}</div>
          </div>
        )}
      </Dialog>
    );
  }

  // ---------- options view
  return (
    <Dialog
      title={t("export.title")}
      onClose={onClose}
      width={640}
      footer={
        <>
          <div className="mr-auto mono text-meta text-fg-2">
            {involved.length > 1
              ? merged
                ? t("export.summaryMergedSrc", { v: vids, dur: fmtClock(totalSec) })
                : t("export.summaryClipsSrc", { n: items.length, v: vids, dur: fmtClock(totalSec) })
              : merged
                ? t("export.summaryMerged", { dur: fmtClock(totalSec) })
                : t("export.summaryClips", { n: items.length, dur: fmtClock(totalSec) })}
            {items.length > 0 && <span className="text-fg-3"> · {t("export.estimate", { time: estimate })}</span>}
          </div>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={start} disabled={starting || !items.length || !dir || blocked}>
            {t("export.start")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ExportOptions value={opts} onChange={setOpts} />
        {(blocked || conforms || skipped > 0 || !items.length) && (
          <div className="flex flex-col gap-1.5 text-meta leading-snug">
            {!items.length && <div className="text-danger">{t("export.noSource")}</div>}
            {blocked && (
              <div className="text-danger">{t("export.copyMergedBlocked", { diff: diffs.map((d) => t(`export.diff.${d}` as const)).join(", ") })}</div>
            )}
            {conforms && <div className="text-fg-2">{t("export.conformNote")}</div>}
            {skipped > 0 && items.length > 0 && <div className="text-fg-2">{t("export.skipped", { n: skipped })}</div>}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <div className="text-meta text-fg-2">{t("export.folder")}</div>
          <div className="flex gap-2">
            <Input value={dir} onChange={(e) => setDir(e.target.value)} className="mono text-meta" spellCheck={false} />
            <Button
              onClick={async () => {
                try {
                  const r = await api.chooseFolder();
                  if (r.path) setDir(r.path);
                } catch (e) {
                  toast("error", errWith(t("ws.actionErr"), e));
                }
              }}
            >
              {t("common.browse")}
            </Button>
          </div>
          <div className="mono text-meta text-fg-3 break-all">{t("export.target", { path: target })}</div>
          <div className="text-meta text-fg-3 leading-snug">
            {system && !system.ffmpeg.ok
              ? t("export.noFfmpeg")
              : encodes
                ? encoder
                  ? t("export.nvenc", { enc: ENCODER_NAME[encoder] })
                  : t("export.noNvenc")
                : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
