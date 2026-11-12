/** Clock-style duration: 4:07 or 1:52:10. */
export function fmtClock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

/** Short scene length: 4.2 s style. Returns e.g. "4.2s" or "1:07" for long ones. */
export function fmtLen(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return fmtClock(sec);
}

/** Frame timecode h:mm:ss:ff for the inspector. */
export function fmtTc(sec: number, fps: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const f = Math.max(1, Math.round(fps));
  const total = Math.round(sec * f);
  const frames = total % f;
  const s = Math.floor(total / f);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

export const snapFrame = (sec: number, fps: number) => Math.round(sec * fps) / fps;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Human ETA: "6 dəq" is handled by callers; this returns h:mm:ss / m:ss. */
export const fmtEta = fmtClock;
