import type { Job, MediaInfo, Source } from "../api";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural order ("Ep2" before "Ep10"), the order the backend gives new sources. */
export const naturalCompare = (a: string, b: string) => collator.compare(a, b);

export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");

export type MediaDiff = "size" | "fps" | "codec" | "audio";

/**
 * Which stream properties differ between the given sources. `copy` + `merged` is only
 * possible when this is empty (ARCHITECTURE.md 7.3), so the export dialog uses it to
 * disable that combination up front.
 */
export function mediaDiffs(medias: MediaInfo[]): MediaDiff[] {
  if (medias.length < 2) return [];
  const a = medias[0];
  const out = new Set<MediaDiff>();
  for (const m of medias.slice(1)) {
    if (m.width !== a.width || m.height !== a.height) out.add("size");
    if (Math.abs(m.fps - a.fps) > 0.01) out.add("fps");
    if (m.videoCodec !== a.videoCodec) out.add("codec");
    if (m.hasAudio !== a.hasAudio || m.audioCodec !== a.audioCodec) out.add("audio");
  }
  return [...out];
}

/**
 * Share (0..1) of the source currently being processed. The job reports one overall
 * progress across its batch, so this assumes the batch sources weigh the same.
 */
export function currentSourceProgress(job: Pick<Job, "progress" | "sourceIndex" | "sourceCount">): number {
  const n = Math.max(1, job.sourceCount);
  return Math.max(0, Math.min(1, job.progress * n - (job.sourceIndex - 1)));
}

/** Sources whose scenes can be previewed / exported. */
export const isUsable = (s: Source) => !s.sourceMissing;
