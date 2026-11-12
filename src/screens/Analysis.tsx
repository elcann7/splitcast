import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "../api";
import type { Job, Project } from "../api";
import { useT, errWith } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../ui/Button";
import { Progress } from "../ui/States";
import { useJob } from "../lib/useJob";
import { useCountUp } from "../lib/motion";
import { navigate, paths } from "../lib/router";
import { fmtClock } from "../lib/time";
import { DeleteProjectButton } from "./DeleteProject";

const STEP_OF: Record<Job["stage"], number> = { probe: 0, shots: 0, faces: 1, cluster: 2, finalize: 3, export: 3, download: 0 };

function BackBar({ title, subtitle }: { title: string; subtitle?: string }) {
  const t = useT();
  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-3 border-b border-line">
      <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} strokeWidth={1.5} />} onClick={() => navigate(paths.library())}>
        {t("ws.back")}
      </Button>
      <div className="h-4 w-px bg-line" />
      <div className="text-body font-medium truncate">{title}</div>
      {subtitle && <div className="mono text-meta text-fg-3 truncate">{subtitle}</div>}
    </header>
  );
}

/** Running, failed and cancelled states of a project that has no analysis result. */
export function AnalysisScreen({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const { job, lost } = useJob(project.activeJobId);
  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // When the job ends, or moves on to its next video, the project's own status may have
  // changed (the first ready video opens the workspace): reload it.
  useEffect(() => {
    if (project.status === "analyzing" && job && (job.status !== "queued" && job.status !== "running" || job.sourceIndex > 1)) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.sourceId]);
  // safety net in case a state change was missed
  useEffect(() => {
    if (project.status !== "analyzing") return;
    const id = setInterval(onChanged, 6000);
    return () => clearInterval(id);
  }, [project.status, onChanged]);

  const failed = project.status === "failed" || (project.status === "analyzing" && job?.status === "failed");
  const cancelled = project.status === "cancelled" || (project.status === "analyzing" && job?.status === "cancelled");
  const multi = project.sources.length > 1;
  const subtitle = multi ? t("common.videoCount", { n: project.sources.length }) : (project.sources[0]?.media.fileName ?? "");

  async function restart() {
    setRestarting(true);
    try {
      await api.rescan(project.id, project.preset);
      onChanged();
    } catch (e) {
      toast("error", errWith(t("rescan.err"), e));
    }
    setRestarting(false);
  }

  if (failed || cancelled) {
    return (
      <div className="h-full flex flex-col">
        <BackBar title={project.title} subtitle={subtitle} />
        <div className="flex-1 min-h-0 overflow-y-auto px-14 py-12">
          <h1 className="text-page font-semibold">{failed ? t("analysis.failedTitle") : t("analysis.cancelledTitle")}</h1>
          <p className="mt-2 text-fg-2 leading-relaxed max-w-[640px]">{failed ? t("analysis.failedBody") : t("analysis.cancelledBody")}</p>
          {failed && (
            <pre className="mt-5 max-w-[860px] rounded-lg border border-line bg-surface-1 px-4 py-3 mono text-meta text-fg-1 whitespace-pre-wrap break-words select-text">
              {job?.error ?? project.error ?? (multi ? project.sources.find((x) => x.error)?.error : null) ?? t("analysis.noErrorText")}
            </pre>
          )}
          {multi && (
            <div className="mt-6 max-w-[860px]">
              <div className="text-meta text-fg-2 mb-2">{t("analysis.perSource")}</div>
              <div className="rounded-lg border border-line divide-y divide-line">
                {project.sources.map((x) => (
                  <div key={x.id} className="flex items-baseline gap-4 px-4 py-2">
                    <span className="text-body truncate min-w-0 flex-1">{x.label}</span>
                    <span className={`text-meta shrink-0 ${x.status === "failed" ? "text-danger" : "text-fg-2"}`}>
                      {x.status === "failed" ? t("src.failed") : x.status === "cancelled" ? t("src.cancelled") : x.status === "ready" ? t("src.ready") : t("src.queued")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 flex items-center gap-2">
            <Button variant="primary" onClick={restart} disabled={restarting}>
              {t("analysis.restart")}
            </Button>
            <Button onClick={() => navigate(paths.library())}>{t("analysis.toLibrary")}</Button>
            <DeleteProjectButton project={project} />
          </div>
        </div>
      </div>
    );
  }

  const step = job ? (job.status === "done" ? 4 : STEP_OF[job.stage]) : 0;
  const steps = [t("analysis.step1"), t("analysis.step2"), t("analysis.step3"), t("analysis.step4")];
  const pct = job ? job.progress : 0;
  const counts = job?.counts;
  const faces = job?.recentFaces ?? [];

  return (
    <div className="h-full flex flex-col">
      <BackBar title={project.title} subtitle={subtitle} />
      <div className="flex-1 min-h-0 overflow-y-auto px-14 py-10 flex flex-col">
        <h1 className="text-page font-semibold">{t("analysis.title")}</h1>
        <div className="mono text-meta text-fg-3 mt-1">
          {multi ? t("common.videoCount", { n: project.sources.length }) : project.sources[0]?.media.fileName} · {fmtClock(project.duration)} · {t(`preset.${project.preset}` as const)}
        </div>
        {multi && job && job.status !== "done" && (
          <div className="mono text-meta text-fg-2 mt-3">
            {t("analysis.sourceLine", { i: job.sourceIndex, n: job.sourceCount, label: project.sources.find((x) => x.id === job.sourceId)?.label ?? "" })}
          </div>
        )}

        <ol className="mt-10 grid grid-cols-4 gap-6">
          {steps.map((label, i) => {
            const state = i < step ? "done" : i === step ? "current" : "todo";
            return (
              <li key={label} className="flex items-baseline gap-2.5" aria-current={state === "current" ? "step" : undefined}>
                <span className={`mono text-meta ${state === "current" ? "text-accent" : state === "done" ? "text-fg-2" : "text-fg-3"}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={`text-section ${state === "current" ? "text-shine font-medium" : state === "done" ? "text-fg-1" : "text-fg-3"}`}>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>

        <Progress value={pct} className="mt-4" />
        <div className="mt-3 flex items-center gap-5 mono text-meta text-fg-2 h-4">
          {lost ? (
            <span className="text-danger">{t("err.network")}</span>
          ) : job && job.status !== "queued" ? (
            <>
              <span className="text-fg-1">{Math.round(pct * 100)}%</span>
              {job.speedFps !== null && <span>{t("analysis.speed", { fps: job.speedFps.toFixed(1) })}</span>}
              {job.etaSeconds !== null && <span>{t("analysis.eta", { eta: fmtClock(job.etaSeconds) })}</span>}
              {job.message && <span className="text-fg-3">{job.message}</span>}
            </>
          ) : (
            <span>{t("analysis.starting")}</span>
          )}
        </div>

        <div className="mt-10 grid grid-cols-4 gap-6">
          {[
            [t("analysis.shots"), counts?.shots],
            [t("analysis.faces"), counts?.faces],
            [t("analysis.characters"), counts?.characters],
          ].map(([label, n]) => (
            <div key={label as string}>
              <div className="text-meta text-fg-2">{label}</div>
              <div className="mono text-page mt-1">
                <Count n={n as number | undefined} />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10">
          <div className="text-meta text-fg-2 mb-3">{t("analysis.recent")}</div>
          <div className="grid grid-cols-12 gap-2">
            {Array.from({ length: 12 }).map((_, i) => {
              const src = faces[i];
              return (
                <div key={i} className="aspect-square rounded-lg bg-surface-1 border border-line overflow-hidden">
                  {src && <img key={src} src={src} alt="" decoding="async" draggable={false} className="w-full h-full object-cover anim-check" />}
                </div>
              );
            })}
          </div>
          {faces.length === 0 && <div className="text-meta text-fg-3 mt-3">{t("analysis.recentEmpty")}</div>}
        </div>

        <div className="mt-auto pt-10 flex items-center gap-4">
          <Button
            disabled={cancelling || !project.activeJobId}
            onClick={async () => {
              if (!project.activeJobId) return;
              setCancelling(true);
              try {
                await api.cancelJob(project.activeJobId);
                onChanged();
              } catch (e) {
                toast("error", errWith(t("ws.actionErr"), e));
                setCancelling(false);
              }
            }}
          >
            {cancelling ? t("analysis.cancelling") : t("analysis.cancel")}
          </Button>
          <span className="text-meta text-fg-3">{t("analysis.hint")}</span>
        </div>
      </div>
    </div>
  );
}

/** A running count that climbs to its new value. */
function Count({ n }: { n: number | undefined }) {
  const v = useCountUp(n);
  return <>{v === undefined ? "—" : v.toLocaleString("en-US")}</>;
}
