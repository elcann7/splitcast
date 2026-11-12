import { api, ApiError } from "../api";
import type { Preset } from "../api";
import { useApp } from "../store/app";
import type { TFn } from "../i18n";

/** Human estimate such as "17 dəq" or "1 saat 12 dəq". */
export function fmtEstimate(sec: number, t: TFn): string {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 90) return `${Math.max(1, Math.round(sec))} ${t("unit.sec")}`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} ${t("unit.min")}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} ${t("unit.h")}` : `${h} ${t("unit.h")} ${m} ${t("unit.min")}`;
}

/**
 * Makes sure a preset's models are on disk. Resolves when they are; rejects with the
 * job's error otherwise. `onProgress` receives 0..1.
 */
export async function ensureModels(preset: Preset, onProgress: (p: number) => void): Promise<void> {
  if (preset.installed) return;
  const { jobId } = await api.downloadModels(preset.id, preset.content);
  for (;;) {
    const job = await api.getJob(jobId);
    onProgress(job.progress);
    if (job.status === "done") break;
    if (job.status === "failed") throw new ApiError("download_failed", job.error ?? "download failed");
    if (job.status === "cancelled") throw new ApiError("download_cancelled", "download cancelled");
    await new Promise((r) => setTimeout(r, 500));
  }
  await useApp.getState().refreshSystem();
}
