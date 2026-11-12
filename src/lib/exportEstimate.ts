/**
 * Rough wall-clock time of an export, so the user sees what the format and quality cost before starting.
 * Calibrated on a 1080p H.264 source: 201 clips (28 min of picture) with NVENC H.264 took about 5 minutes.
 * "Speed" is minutes of picture written per minute of waiting.
 */
export function estimateExportSec(opts: {
  codec: string;
  quality: string;
  merged: boolean;
  nvenc: boolean;
  clips: number;
  pictureSec: number;
}): number {
  const { codec, quality, merged, nvenc, clips, pictureSec } = opts;
  let perClip = 0.35; // starting ffmpeg and seeking in the source
  let speed: number;
  switch (codec) {
    case "copy":
      perClip = 0.08;
      speed = 200;
      break;
    case "hevc":
      speed = nvenc ? 5 : 0.6;
      break;
    case "prores":
      speed = 2.5;
      break;
    default:
      speed = nvenc ? 7 : 1.2;
  }
  if (quality === "master" && codec !== "copy") speed /= 1.25;
  return clips * perClip + pictureSec / speed + (merged ? 0.5 + pictureSec / 300 : 0);
}

/** "<5 s", "40 s", "5 min", "1 h 05 min" with the translated unit labels. */
export function fmtEstimate(sec: number, unit: { h: string; min: string; sec: string }): string {
  if (sec < 5) return `<5 ${unit.sec}`;
  if (sec < 90) return `${Math.round(sec / 5) * 5} ${unit.sec}`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${unit.min}`;
  const h = Math.floor(min / 60);
  return `${h} ${unit.h} ${String(min % 60).padStart(2, "0")} ${unit.min}`;
}
