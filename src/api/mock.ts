// In-memory implementation of the Api interface for developing and reviewing the UI
// without the Python backend. Enabled with ?mock=1 or VITE_MOCK=1.
//
// Mock projects follow ARCHITECTURE.md 7: a project holds sources, characters span
// sources, and an analysis job walks through its batch one source at a time. A source's
// appearances exist from the start but only show up in the Project once the source is
// "ready", so a running job makes characters and scenes arrive source by source.
//
// Review URL parameters (all optional, in the page query, before the #):
//   fast            no artificial latency
//   empty           empty library
//   listfail        project list request fails
//   mockfreeze=0.4  freeze the running fixtures (p2, p8, p10) at a fraction of their batch
//   mockms=20000    duration of a single-video analysis (default 60000)
//   mocksrc=9000    time per source in a multi-video analysis (default 9000)
//   mockpick=8      how many files the fake "open video" dialog returns (default 3)
//   exportms=3000   fixed export duration
//   lang=en
import { ApiError } from "./types";
import type {
  Api, Appearance, Character, ExportRequest, Job, MediaInfo, PresetId, Project, ProjectSummary,
  Settings, ShotSize, Source, SystemInfo,
} from "./types";
import { faceArt, rng, stillArt } from "./mockArt";
import { fileNameOf, mediaDiffs, naturalCompare, stripExt } from "../lib/sources";

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const FAST = params.has("fast");
const EMPTY = params.has("empty");
const LIST_FAIL = params.has("listfail");
const FREEZE = params.get("mockfreeze") !== null ? Number(params.get("mockfreeze")) : null;
const ANALYSIS_MS = Number(params.get("mockms") ?? 60000);
const SRC_MS = Number(params.get("mocksrc") ?? 9000);
const PICK_N = Number(params.get("mockpick") ?? 3);

const delay = (ms = 160) => new Promise<void>((r) => setTimeout(r, FAST ? 0 : ms + Math.random() * 120));

interface MockChar {
  id: string;
  name: string;
  thumb: string;
  hidden: boolean;
  /** every appearance, including those of sources that are not ready yet */
  apps: Appearance[];
}

interface MockProject {
  id: string;
  title: string;
  createdAt: string;
  preset: PresetId;
  seed: number;
  pFace: number;
  nMain: number;
  multi: boolean;
  /** per main character: the source sequence numbers it appears in (null = decided by a rule) */
  subsets: (number[] | null)[];
  sources: Source[];
  seqOf: Map<string, number>;
  failing: Map<string, string>;
  chars: MockChar[];
  nextApp: number;
  nextChar: number;
  nextSrc: number;
  jobId: string | null;
  error: string | null;
  initialSources: number;
}

interface MockJob {
  id: string;
  type: Job["type"];
  startedAt: number;
  durationMs: number;
  perSourceMs: number;
  /** analysis: source ids processed in order */
  batch: string[];
  freezeBase: number;
  freezable: boolean;
  cancelled: boolean;
  failed: string | null;
  projectId?: string;
  req?: ExportRequest;
  preset?: PresetId;
  settled: boolean;
}

const projects = new Map<string, MockProject>();
const jobs = new Map<string, MockJob>();
let jobSeq = 1;
let projSeq = 20;

// ---------------------------------------------------------------- cast generator

const NAMES = ["Aysel", "Rauf", "Nigar", "Elvin", "Səbinə"];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function isPresent(p: MockProject, ci: number, seq: number): boolean {
  if (ci >= p.nMain) {
    // extras show up in exactly one source
    return seq === ((ci - p.nMain) * 4 + 2) % Math.max(1, p.initialSources);
  }
  if (!p.multi || ci === 0) return true;
  const sub = p.subsets[ci];
  if (sub) return sub.includes(seq);
  return rng(p.seed * 131 + ci * 977 + seq * 17)() < Math.max(0.35, 0.88 - ci * 0.06);
}

/** Generate this source's appearances for the project's characters. Returns shot and face counts. */
function genSource(p: MockProject, src: Source, seq: number) {
  const r = rng(p.seed * 7919 + seq * 104729 + 17);
  const duration = src.media.duration;
  const present = p.chars.map((_, ci) => isPresent(p, ci, seq));
  const mains: number[] = [];
  for (let i = 0; i < p.nMain; i++) if (present[i]) mains.push(i);
  const weights = mains.map((ci) => 1 / Math.pow(ci + 1, 0.95));
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const pick = (exclude: Set<number>) => {
    for (let tries = 0; tries < 20; tries++) {
      let x = r() * wSum;
      for (let i = 0; i < mains.length; i++) {
        x -= weights[i];
        if (x <= 0) {
          if (!exclude.has(mains[i])) return mains[i];
          break;
        }
      }
    }
    return -1;
  };
  const push = (ci: number, a: Appearance) => p.chars[ci].apps.push(a);
  let t = 0;
  let shotIndex = 0;
  let faceCount = 0;
  const hueBase = 200 + seq * 37;
  while (t < duration - 0.5 && mains.length) {
    const len = Math.min(duration - t, 1 + 9.3 * Math.pow(r(), 1.8));
    const start = t;
    const end = t + len;
    t = end;
    const idx = shotIndex++;
    if (len < 0.8 || r() > p.pFace) continue;
    const k = r() < 0.6 ? 1 : r() < 0.7 ? 2 : 3;
    const chosen = new Set<number>();
    for (let j = 0; j < k; j++) {
      const c = pick(chosen);
      if (c >= 0) chosen.add(c);
    }
    const extras = r() < 0.15 ? 1 : 0;
    const people = chosen.size + extras;
    const hue = (Math.floor(start / 540) * 53 + hueBase) % 360;
    chosen.forEach((ci) => {
      const sizeRoll = r();
      const size: ShotSize = sizeRoll < 0.28 ? "closeup" : sizeRoll < 0.72 ? "medium" : "wide";
      const a0 = start + (r() < 0.3 ? r() * len * 0.2 : 0);
      const a1 = Math.max(a0 + 0.8, end - (r() < 0.3 ? r() * len * 0.2 : 0));
      const lowConf = r() < 0.05;
      push(ci, {
        id: `${p.id}-a${p.nextApp++}`,
        sourceId: src.id,
        shotIndex: idx,
        start: +a0.toFixed(3),
        end: +Math.min(a1, end).toFixed(3),
        thumb: stillArt(idx * 31 + ci + seq * 100003, hue, size, people),
        previewOffset: +Math.min(2, a0).toFixed(3),
        shotSize: size,
        solo: people === 1,
        peopleCount: people,
        coverage: +(0.45 + r() * 0.55).toFixed(2),
        confidence: lowConf ? +(0.5 + r() * 0.15).toFixed(2) : +(0.7 + r() * 0.29).toFixed(2),
      });
      faceCount += Math.round(len * 3);
    });
  }
  // extras: a handful of very short appearances each
  for (let ci = p.nMain; ci < p.chars.length; ci++) {
    if (!present[ci]) continue;
    const m = ci - p.nMain;
    for (let j = 0; j < 1 + m; j++) {
      const start = +(r() * Math.max(1, duration - 10)).toFixed(2);
      const idx = Math.floor((start / duration) * shotIndex);
      push(ci, {
        id: `${p.id}-a${p.nextApp++}`,
        sourceId: src.id,
        shotIndex: idx,
        start,
        end: +(start + 1.2 + r()).toFixed(2),
        thumb: stillArt(idx * 17 + ci + seq * 100003, 30 + m * 80, "wide", 3),
        previewOffset: 2,
        shotSize: "wide",
        solo: false,
        peopleCount: 3,
        coverage: +(0.4 + r() * 0.3).toFixed(2),
        confidence: +(0.55 + r() * 0.2).toFixed(2),
      });
    }
  }
  src.stats = { shotCount: shotIndex, faceCount, analysisSeconds: Math.round(duration / 4.2) };
}

// ---------------------------------------------------------------- fixtures

function media(fileName: string, duration: number, w = 1920, h = 1080, fps = 23.976, codec = "H.264", dir = "D:\\Filmlər"): MediaInfo {
  return {
    path: `${dir}\\${fileName}`, fileName, sizeBytes: Math.round(duration * 1.1e6),
    duration, width: w, height: h, fps, videoCodec: codec, audioCodec: "AAC", hasAudio: true,
  };
}

interface SrcSpec {
  file: string;
  duration: number;
  w?: number;
  h?: number;
  fps?: number;
  codec?: string;
  status?: Source["status"];
  missing?: boolean;
  error?: string;
  label?: string;
}

function newProject(o: {
  id: string; title: string; preset: PresetId; seed: number; chars: number; pFace: number; ageDays: number;
  sources: SrcSpec[]; subsets?: (number[] | null)[]; dir?: string; error?: string | null;
}): MockProject {
  const p: MockProject = {
    id: o.id, title: o.title, createdAt: new Date(Date.now() - o.ageDays * 86400000).toISOString(), preset: o.preset,
    seed: o.seed, pFace: o.pFace, nMain: Math.max(1, o.chars - 2), multi: o.sources.length > 1, subsets: o.subsets ?? [],
    sources: [], seqOf: new Map(), failing: new Map(), chars: [], nextApp: 0, nextChar: o.chars + 1, nextSrc: 1,
    jobId: null, error: o.error ?? null, initialSources: o.sources.length,
  };
  for (let i = 0; i < o.chars; i++) {
    const named = o.seed % 2 === 1 && i < NAMES.length;
    p.chars.push({
      id: `${o.id}-c${i}`,
      name: named ? NAMES[i] : `Personaj ${String(i + 1).padStart(2, "0")}`,
      thumb: faceArt(o.seed + i * 7, (i * 47 + 20) % 360),
      hidden: false,
      apps: [],
    });
  }
  for (const s of o.sources) pushSource(p, s, o.dir);
  return p;
}

function pushSource(p: MockProject, s: SrcSpec, dir?: string): Source {
  const seq = p.nextSrc - 1;
  const id = `${p.id}-s${p.nextSrc++}`;
  const m = media(s.file, s.duration, s.w, s.h, s.fps, s.codec, dir);
  const status = s.status ?? "ready";
  const src: Source = {
    id, label: s.label ?? stripExt(s.file), order: p.sources.length, media: m, status,
    sourceMissing: !!s.missing, error: s.error ?? null, stats: null, poster: null,
  };
  p.sources.push(src);
  p.seqOf.set(id, seq);
  genSource(p, src, seq);
  src.poster = stillArt(p.seed * 5 + seq * 11, (p.seed * 29 + seq * 41) % 360, "medium", 2);
  if (s.error && status === "failed") p.failing.set(id, s.error);
  return src;
}

function addFixtures() {
  const add = (p: MockProject) => projects.set(p.id, p);

  add(newProject({ id: "p1", title: "Son Stansiya", preset: "balanced", seed: 11, chars: 12, pFace: 0.22, ageDays: 2, sources: [{ file: "Son.Stansiya.2021.1080p.BluRay.mkv", duration: 6730 }] }));

  const p2 = newProject({ id: "p2", title: "Küləklər Şəhəri", preset: "fast", seed: 22, chars: 9, pFace: 0.25, ageDays: 0, sources: [{ file: "Kulekler.Seheri.S01E01.mkv", duration: 5924, status: "analyzing" }] });
  add(p2);
  startFixtureJob(p2, "job-p2", ANALYSIS_MS, 0, true);

  add(newProject({ id: "p3", title: "Şəhər İşıqları S01E04", preset: "fast", seed: 33, chars: 6, pFace: 0.95, ageDays: 5, sources: [{ file: "Seher.Isiqlari.S01E04.mp4", duration: 6180, w: 1280, h: 720, fps: 25 }] }));
  add(newProject({ id: "p4", title: "Qara Dəniz (2019)", preset: "max", seed: 44, chars: 8, pFace: 0.2, ageDays: 14, sources: [{ file: "Qara.Deniz.2019.2160p.HEVC.mkv", duration: 7410, w: 3840, h: 2160, codec: "HEVC", missing: true }] }));
  const ERR = "Decoding stopped at 41:07: Invalid data found when processing input. The video file may be damaged; try re-downloading it or remuxing it with ffmpeg.";
  add(newProject({ id: "p5", title: "Qış Yuxusu", preset: "balanced", seed: 55, chars: 0, pFace: 0, ageDays: 20, error: ERR, sources: [{ file: "Qis.Yuxusu.1080p.avi", duration: 4865, codec: "MPEG-4", status: "failed", error: ERR }] }));
  add(newProject({ id: "p6", title: "Dərin Su", preset: "fast", seed: 66, chars: 0, pFace: 0, ageDays: 30, sources: [{ file: "Derin.Su.2018.mkv", duration: 3360, status: "cancelled" }] }));

  // A finished season. Ep 5 is 720p/25 fps, so copy + merged is not possible across all of it.
  const dur = [2580, 2760, 2640, 3120, 2700, 2490, 3300, 2880];
  const S = "D:\\Seriallar\\Dəmir Körpü";
  add(
    newProject({
      id: "p7", title: "Dəmir Körpü", preset: "balanced", seed: 77, chars: 11, pFace: 0.86, ageDays: 3, dir: S,
      subsets: [null, [0, 1, 2, 3, 4, 5], [0, 1, 2, 3], [2, 3, 4, 5, 6, 7], [4, 5, 6, 7], [0, 1, 6, 7], null, [1, 3, 5, 7], null],
      sources: dur.map((d, i) => ({
        file: `Demir.Korpu.S02E0${i + 1}.mkv`, duration: d, ...(i === 4 ? { w: 1280, h: 720, fps: 25 } : {}),
      })),
    }),
  );

  // A season still being analysed: episodes 1–3 are ready, the job is on 4 of 8.
  const S8 = "D:\\Seriallar\\Qarlı Yollar";
  const dur8 = [2460, 2520, 2700, 2640, 2580, 2760, 2400, 2820];
  const p8 = newProject({
    id: "p8", title: "Qarlı Yollar", preset: "balanced", seed: 88, chars: 10, pFace: 0.8, ageDays: 0, dir: S8,
    sources: dur8.map((d, i) => ({ file: `Qarli.Yollar.S01E0${i + 1}.mkv`, duration: d, status: i < 3 ? ("ready" as const) : ("queued" as const) })),
  });
  add(p8);
  startFixtureJob(p8, "job-p8", SRC_MS * 8, 3, true);

  // A season with trouble: one failed source, one whose file is gone, one cancelled.
  const S9 = "D:\\Seriallar\\Meşə Qapısı";
  add(
    newProject({
      id: "p9", title: "Meşə Qapısı", preset: "fast", seed: 99, chars: 8, pFace: 0.8, ageDays: 6, dir: S9,
      sources: [
        { file: "Mese.Qapisi.E01.mp4", duration: 2640 },
        { file: "Mese.Qapisi.E02.mp4", duration: 2700 },
        { file: "Mese.Qapisi.E03.mp4", duration: 2580, status: "failed", error: "Decoding stopped at 18:52: Invalid data found when processing input. The file may be damaged; try re-downloading it." },
        { file: "Mese.Qapisi.E04.mp4", duration: 2760 },
        { file: "Mese.Qapisi.E05.mp4", duration: 2520, missing: true },
        { file: "Mese.Qapisi.E06.mp4", duration: 2640, status: "cancelled" },
      ],
    }),
  );

  // A new season where no source is ready yet: shows the full-page analysis.
  const p10 = newProject({
    id: "p10", title: "Yeni Mövsüm", preset: "fast", seed: 101, chars: 8, pFace: 0.8, ageDays: 0, dir: "D:\\Seriallar\\Yeni Mövsüm",
    sources: [1, 2, 3].map((n) => ({ file: `Yeni.Movsum.E0${n}.mkv`, duration: 2400 + n * 120, status: "queued" as const })),
  });
  add(p10);
  startFixtureJob(p10, "job-p10", SRC_MS * 3, 0, true);
}

function startFixtureJob(p: MockProject, id: string, durationMs: number, doneCount: number, freezable: boolean) {
  const batch = p.sources.map((s) => s.id);
  const perSourceMs = batch.length === 1 ? ANALYSIS_MS : SRC_MS;
  jobs.set(id, {
    id, type: "analysis", startedAt: Date.now() - doneCount * perSourceMs, durationMs, perSourceMs, batch,
    freezeBase: doneCount, freezable, cancelled: false, failed: null, projectId: p.id, settled: false,
  });
  p.jobId = id;
}

// ---------------------------------------------------------------- jobs

function srcById(p: MockProject, id: string) {
  return p.sources.find((s) => s.id === id);
}

/** Move the sources of an analysis job's batch to the state they should have right now. */
function advance(j: MockJob): number {
  const p = projects.get(j.projectId ?? "");
  const N = j.batch.length;
  let pos = (Date.now() - j.startedAt) / j.perSourceMs;
  if (j.freezable && FREEZE !== null && !j.settled) pos = j.freezeBase + FREEZE * (N - j.freezeBase);
  if (j.settled || j.cancelled) return j.settled && !j.cancelled ? N : Math.min(N, pos);
  if (p) {
    const idx = Math.floor(pos);
    j.batch.forEach((sid, k) => {
      const s = srcById(p, sid);
      if (!s) return;
      if (k < idx) {
        const fail = p.failing.get(sid);
        if (fail) {
          s.status = "failed";
          s.error = fail;
        } else {
          s.status = "ready";
          s.error = null;
        }
      } else if (k === idx) {
        s.status = "analyzing";
      } else {
        s.status = "queued";
      }
    });
  }
  if (pos >= N) {
    j.settled = true;
    if (p && p.jobId === j.id) p.jobId = null;
    return N;
  }
  return pos;
}

function advanceAll() {
  jobs.forEach((j) => {
    if (j.type === "analysis" && !j.settled && !j.cancelled) advance(j);
  });
}

function settleDownload(j: MockJob) {
  if (j.settled) return;
  j.settled = true;
  if (j.preset) presetInstalled.add(j.preset);
}

function jobState(j: MockJob): Job {
  const now = Date.now();
  const base: Job = {
    id: j.id, type: j.type, status: "running", progress: 0, stage: "probe", message: null, speedFps: null,
    etaSeconds: null, recentFaces: [], counts: null, error: null, sourceId: null, sourceIndex: 1, sourceCount: 1, result: null,
  };
  if (j.type === "analysis") {
    const p = projects.get(j.projectId ?? "");
    const N = j.batch.length;
    const pos = advance(j);
    const idx = Math.min(N - 1, Math.floor(pos));
    const loc = Math.min(1, pos - idx);
    const common = { sourceId: j.batch[idx] ?? null, sourceIndex: idx + 1, sourceCount: N };
    if (j.failed) return { ...base, ...common, status: "failed", progress: 0.46, stage: "faces", error: j.failed, counts: { shots: 1031, faces: 2840, characters: 0 } };
    if (j.cancelled) return { ...base, ...common, status: "cancelled", progress: Math.min(1, pos / N) };
    const done = j.settled;
    let stage: Job["stage"] = "probe";
    if (loc >= 0.92) stage = "finalize";
    else if (loc >= 0.8) stage = "cluster";
    else if (loc >= 0.34) stage = "faces";
    else if (loc >= 0.04) stage = "shots";
    const total = p?.sources[idx]?.media.duration ?? 6000;
    const nShots = Math.round(Math.min(1, loc / 0.34) * 1558);
    const nFaces = Math.round(Math.max(0, (loc - 0.34) / 0.46) * 4200);
    const faces: string[] = [];
    if (stage === "faces" || stage === "cluster") {
      const base0 = Math.floor(loc * 400) + idx * 500;
      for (let i = 0; i < 12; i++) faces.push(faceArt(base0 - i + 1000, (((base0 - i) * 47) % 9) * 40));
    }
    return {
      ...base,
      ...common,
      sourceId: done ? null : common.sourceId,
      status: done ? "done" : "running",
      stage: done ? "finalize" : stage,
      progress: done ? 1 : Math.min(1, pos / N),
      message: stage === "shots" ? `shot ${nShots} / 1558` : stage === "faces" ? `frame ${Math.round(((loc - 0.34) / 0.46) * total * 4)} / ${Math.round(total * 4)}` : stage === "cluster" ? "tracklets" : null,
      speedFps: done ? null : 38.6 + Math.sin(loc * 20) * 3,
      etaSeconds: done ? null : Math.round(((N - pos) * j.perSourceMs) / 1000),
      recentFaces: faces,
      counts: { shots: nShots, faces: nFaces, characters: Math.round(Math.max(0, (loc - 0.6) / 0.4) * 11) },
      result: done ? { projectId: j.projectId } : null,
    };
  }
  let f = Math.min(1, (now - j.startedAt) / j.durationMs);
  if (j.failed) return { ...base, status: "failed", progress: 0.46, stage: "export", error: j.failed };
  if (j.cancelled) return { ...base, status: "cancelled" };
  const done = f >= 1;
  const remainingS = Math.max(0, ((1 - f) * j.durationMs) / 1000);
  if (j.type === "export" && j.req) {
    const files = exportFiles(j);
    return {
      ...base,
      status: done ? "done" : "running",
      stage: "export",
      progress: done ? 1 : f,
      message: done ? null : `clip ${Math.min(files.length, Math.floor(f * files.length) + 1)} / ${files.length}`,
      etaSeconds: done ? null : Math.round(remainingS),
      result: done ? { outputDir: outputDirOf(j), files } : null,
    };
  }
  if (done) settleDownload(j);
  f = Math.min(1, f);
  return { ...base, status: done ? "done" : "running", stage: "download", progress: done ? 1 : f, message: done ? null : `${Math.round(f * 540)} / 540 MB`, etaSeconds: done ? null : Math.round(remainingS) };
}

function charOf(j: MockJob) {
  const p = projects.get(j.projectId ?? "");
  return { p, ch: p?.chars.find((c) => c.id === j.req?.characterId) };
}
function outputDirOf(j: MockJob) {
  const { p, ch } = charOf(j);
  return `${j.req?.outputDir}\\${p?.title}\\${ch?.name ?? "Personaj"}`;
}
function exportFiles(j: MockJob): string[] {
  const { p, ch } = charOf(j);
  const ext = j.req?.codec === "prores" ? "mov" : "mp4";
  const dir = outputDirOf(j);
  if (!p || !ch || !j.req) return [];
  if (j.req.mode === "merged") return [`${dir}\\${ch.name} - merged.${ext}`];
  // <Character> - <SourceLabel> - 001.<ext>, numbered per source
  const ids = new Set(j.req.appearanceIds);
  const counters = new Map<string, number>();
  const out: string[] = [];
  const order = new Map(p.sources.map((s) => [s.id, s.order]));
  const apps = ch.apps.filter((a) => ids.has(a.id)).sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0) || a.start - b.start);
  for (const a of apps) {
    const s = srcById(p, a.sourceId);
    if (!s || s.sourceMissing) continue;
    const n = (counters.get(s.id) ?? 0) + 1;
    counters.set(s.id, n);
    out.push(`${dir}\\${ch.name} - ${s.label} - ${String(n).padStart(3, "0")}.${ext}`);
  }
  return out;
}

// ---------------------------------------------------------------- system & settings

const presetInstalled = new Set<PresetId>(["fast", "balanced"]);
const system = (): SystemInfo => ({
  version: "0.1.0-mock",
  device: { provider: "cuda", gpuName: "NVIDIA GeForce RTX 5060", vramMb: 8151, note: null },
  ffmpeg: { ok: true, version: "7.1.1-essentials", nvenc: true, encoder: "nvenc" },
  presets: [
    { id: "fast", content: "live", shotDetector: "Content-adaptive", faceDetector: "SCRFD-500MF @640", faceRecognizer: "ArcFace MobileFaceNet", sampleFps: 2, installed: presetInstalled.has("fast"), downloadMb: presetInstalled.has("fast") ? 0 : 38, speedFactor: 14 },
    { id: "balanced", content: "live", shotDetector: "TransNetV2", faceDetector: "SCRFD-10GF @640", faceRecognizer: "ArcFace R50", sampleFps: 4, installed: presetInstalled.has("balanced"), downloadMb: presetInstalled.has("balanced") ? 0 : 211, speedFactor: 6.5 },
    { id: "max", content: "live", shotDetector: "TransNetV2", faceDetector: "SCRFD-10GF @960", faceRecognizer: "ArcFace R100 Glint360K", sampleFps: 8, installed: presetInstalled.has("max"), downloadMb: presetInstalled.has("max") ? 0 : 540, speedFactor: 2.1 },
  ],
  paths: { data: "C:\\Users\\Demo\\AppData\\Local\\ScenepackStudio", defaultExportDir: "C:\\Users\\Demo\\Videos\\Scenepack" },
});

let settings: Settings = {
  language: params.get("lang") === "en" ? "en" : params.get("lang") === "ar" ? "ar" : "az",
  device: "auto",
  defaultPreset: "balanced",
  exportDir: "C:\\Users\\Demo\\Videos\\Scenepack",
  export: { mode: "clips", codec: "h264", quality: "high", audio: true, paddingMs: 200, joinAdjacent: true },
};
let previewsBytes = 1.34e9;

// ---------------------------------------------------------------- views

const statusOf = (p: MockProject): ProjectSummary["status"] => {
  if (p.sources.some((s) => s.status === "ready")) return "ready";
  if (p.sources.some((s) => s.status === "analyzing" || s.status === "queued")) return "analyzing";
  if (p.sources.some((s) => s.status === "failed")) return "failed";
  return "cancelled";
};

function summaryOf(p: MockProject): ProjectSummary {
  const ready = new Set(p.sources.filter((s) => s.status === "ready").map((s) => s.id));
  const firstReady = p.sources.find((s) => s.status === "ready");
  const characterCount = p.chars.filter((c) => c.apps.some((a) => ready.has(a.sourceId))).length;
  return {
    id: p.id, title: p.title, createdAt: p.createdAt, status: statusOf(p), preset: p.preset, content: "live",
    duration: p.sources.reduce((s, x) => s + x.media.duration, 0),
    sourceCount: p.sources.length, readySourceCount: ready.size,
    poster: firstReady?.poster ?? null, characterCount, activeJobId: p.jobId,
  };
}

function view(p: MockProject): Project {
  const ready = new Set(p.sources.filter((s) => s.status === "ready").map((s) => s.id));
  const order = new Map(p.sources.map((s) => [s.id, s.order]));
  const characters: Character[] = [];
  for (const c of p.chars) {
    const apps = c.apps.filter((a) => ready.has(a.sourceId));
    if (!apps.length) continue;
    apps.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0) || a.start - b.start);
    const screenTime = +apps.reduce((s, a) => s + (a.end - a.start), 0).toFixed(3);
    characters.push({
      id: c.id, name: c.name, thumb: c.thumb, hidden: c.hidden,
      isMinor: apps.length < 3 && screenTime < 4,
      screenTime, appearanceCount: apps.length,
      sourceCount: new Set(apps.map((a) => a.sourceId)).size,
      appearances: apps.map((a) => ({ ...a })), // fresh objects, like a real JSON response
    });
  }
  characters.sort((a, b) => b.screenTime - a.screenTime);
  return {
    ...summaryOf(p),
    error: p.error,
    sources: p.sources.map((s) => ({ ...s, media: { ...s.media }, stats: s.status === "ready" ? s.stats : null })),
    characters,
  };
}

function must(id: string): MockProject {
  const p = projects.get(id);
  if (!p) throw new ApiError("not_found", "Project not found");
  return p;
}
function mustSource(p: MockProject, sid: string): Source {
  const s = srcById(p, sid);
  if (!s) throw new ApiError("not_found", "Video not found");
  return s;
}

const SAMPLE_PATHS = [
  "D:\\Filmlər\\Gecə Növbəsi.2022.1080p.WEB-DL.mkv",
  "D:\\Seriallar\\Dəmir Körpü\\S02E05.mp4",
  "E:\\Video\\Yarımçıq Yol (2017).mkv",
];
let dialogCount = 0;

function mediaFor(path: string): MediaInfo {
  const h = hash(path);
  const name = fileNameOf(path);
  const hd = /720/.test(path);
  return { ...media(name, 2400 + (h % 1500) + 0.4, hd ? 1280 : 1920, hd ? 720 : 1080, hd ? 25 : 23.976), path };
}

function addJobFor(p: MockProject, sids: string[]): string {
  const live = p.jobId ? jobs.get(p.jobId) : undefined;
  if (live && !live.settled && !live.cancelled) {
    live.batch.push(...sids);
    live.freezable = false;
    return live.id;
  }
  const id = `job-${jobSeq++}`;
  const perSourceMs = sids.length === 1 && p.sources.length === 1 ? ANALYSIS_MS : SRC_MS;
  jobs.set(id, {
    id, type: "analysis", startedAt: Date.now(), durationMs: perSourceMs * sids.length, perSourceMs, batch: [...sids],
    freezeBase: 0, freezable: false, cancelled: false, failed: null, projectId: p.id, settled: false,
  });
  p.jobId = id;
  return id;
}

function specFor(path: string, p?: MockProject): SrcSpec {
  const m = mediaFor(path);
  return { file: m.fileName, duration: m.duration, w: m.width, h: m.height, fps: m.fps, status: "queued", missing: /missing/i.test(path) && !!p };
}

// ---------------------------------------------------------------- the Api

addFixtures();

export const mockApi: Api = {
  mock: true,
  async system() { await delay(); return system(); },
  async downloadModels(preset) {
    await delay();
    const id = `job-${jobSeq++}`;
    jobs.set(id, { id, type: "download", startedAt: Date.now(), durationMs: 6000, perSourceMs: 6000, batch: [], freezeBase: 0, freezable: false, cancelled: false, failed: null, preset, settled: false });
    return { jobId: id };
  },
  async openVideoDialog() {
    await delay(350);
    const n = dialogCount++;
    if (PICK_N <= 1) return { paths: [SAMPLE_PATHS[n % SAMPLE_PATHS.length]] };
    const dir = "D:\\Seriallar\\Dəmir Körpü";
    return { paths: Array.from({ length: PICK_N }, (_, i) => `${dir}\\Demir.Korpu.S0${(n % 3) + 3}E${String(i + 1).padStart(2, "0")}.mkv`) };
  },
  async chooseFolder() { await delay(300); return { path: "D:\\Montaj\\Scenepack" }; },
  async probe(path) {
    await delay(300);
    if (/bad|corrupt/i.test(path)) throw new ApiError("unreadable_media", "ffprobe could not read this file: moov atom not found.");
    return mediaFor(path);
  },
  async listProjects() {
    await delay();
    if (LIST_FAIL) throw new ApiError("network", "network");
    if (EMPTY) return [];
    advanceAll();
    return [...projects.values()].map(summaryOf).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async createProject({ paths, title, preset }) {
    await delay(300);
    const id = `p${projSeq++}`;
    const sorted = [...paths].sort((a, b) => naturalCompare(fileNameOf(a), fileNameOf(b)));
    const seed = hash(sorted.join("|"));
    const p = newProject({
      id, title: title || stripExt(fileNameOf(sorted[0])), preset, seed, chars: 9 + (seed % 4), pFace: 0.5, ageDays: 0, sources: [],
    });
    p.initialSources = sorted.length;
    p.multi = sorted.length > 1;
    projects.set(id, p);
    const sids = sorted.map((path) => {
      const src = pushSource(p, { ...specFor(path), file: fileNameOf(path) }, undefined);
      src.media.path = path;
      if (/fail/i.test(path)) p.failing.set(src.id, "Decoding stopped at 03:12: Invalid data found when processing input.");
      return src.id;
    });
    const jobId = addJobFor(p, sids);
    return { projectId: id, jobId };
  },
  async getProject(id) { await delay(); advanceAll(); return view(must(id)); },
  async renameProject(id, title) { await delay(100); const p = must(id); p.title = title; return view(p); },
  async deleteProject(id) { await delay(); projects.delete(id); return { ok: true }; },
  async rescan(id, preset) {
    await delay();
    const p = must(id);
    p.preset = preset;
    p.seed += 1;
    const old = p.chars;
    p.chars = old.map((c, i) => ({ ...c, thumb: faceArt(p.seed + i * 7, (i * 47 + 20) % 360), apps: [] }));
    p.nextApp = 0;
    p.sources.forEach((s) => {
      s.status = "queued";
      s.error = null;
      genSource(p, s, p.seqOf.get(s.id) ?? 0);
    });
    p.error = null;
    p.failing.clear();
    const live = p.jobId ? jobs.get(p.jobId) : undefined;
    if (live) live.cancelled = true;
    p.jobId = null;
    const jobId = addJobFor(p, p.sources.map((s) => s.id));
    return { jobId };
  },
  async addSources(id, paths) {
    await delay(250);
    const p = must(id);
    const have = new Set(p.sources.map((s) => s.media.path.toLowerCase()));
    const fresh = [...new Set(paths)].filter((x) => !have.has(x.toLowerCase())).sort((a, b) => naturalCompare(fileNameOf(a), fileNameOf(b)));
    if (!fresh.length) throw new ApiError("already_added", "These videos are already in the project.");
    p.multi = true;
    const sids = fresh.map((path) => {
      const src = pushSource(p, specFor(path, p));
      src.media.path = path;
      return src.id;
    });
    const jobId = addJobFor(p, sids);
    return { jobId, sourceIds: sids };
  },
  async patchSource(id, sid, { label }) {
    await delay(100);
    const p = must(id);
    mustSource(p, sid).label = label;
    return view(p);
  },
  async deleteSource(id, sid) {
    await delay(200);
    const p = must(id);
    mustSource(p, sid);
    if (p.sources.length === 1) throw new ApiError("last_source", "A project needs at least one video.");
    p.sources = p.sources.filter((s) => s.id !== sid);
    p.sources.forEach((s, i) => (s.order = i));
    p.chars.forEach((c) => (c.apps = c.apps.filter((a) => a.sourceId !== sid)));
    p.chars = p.chars.filter((c) => c.apps.length > 0);
    jobs.forEach((j) => (j.batch = j.batch.filter((x) => x !== sid)));
    return view(p);
  },
  async rescanSource(id, sid) {
    await delay(200);
    const p = must(id);
    const s = mustSource(p, sid);
    s.status = "queued";
    s.error = null;
    p.failing.delete(sid);
    p.chars.forEach((c) => (c.apps = c.apps.filter((a) => a.sourceId !== sid)));
    genSource(p, s, p.seqOf.get(sid) ?? 0);
    const jobId = addJobFor(p, [sid]);
    return { jobId };
  },
  async patchCharacter(id, cid, body) {
    await delay(80);
    const p = must(id);
    const c = p.chars.find((x) => x.id === cid);
    if (!c) throw new ApiError("not_found", "Character not found");
    if (body.name !== undefined) c.name = body.name;
    if (body.hidden !== undefined) c.hidden = body.hidden;
    return view(p);
  },
  async mergeCharacters(id, { sourceIds, targetId }) {
    await delay(200);
    const p = must(id);
    const target = p.chars.find((c) => c.id === targetId);
    if (!target) throw new ApiError("not_found", "Target character not found");
    const rest: MockChar[] = [];
    for (const c of p.chars) {
      if (c.id !== targetId && sourceIds.includes(c.id)) target.apps.push(...c.apps);
      else rest.push(c);
    }
    p.chars = rest;
    return view(p);
  },
  async moveAppearances(id, { appearanceIds, targetCharacterId }) {
    await delay(200);
    const p = must(id);
    const ids = new Set(appearanceIds);
    const moved: Appearance[] = [];
    for (const c of p.chars) {
      moved.push(...c.apps.filter((a) => ids.has(a.id)));
      c.apps = c.apps.filter((a) => !ids.has(a.id));
    }
    let target = p.chars.find((c) => c.id === targetCharacterId);
    if (targetCharacterId === "new") {
      const n = p.nextChar++;
      target = { id: `${id}-c${n}`, name: `Personaj ${String(n).padStart(2, "0")}`, thumb: faceArt(n * 13, (n * 47) % 360), hidden: false, apps: [] };
      p.chars.push(target);
    }
    if (!target) throw new ApiError("not_found", "Target character not found");
    target.apps.push(...moved);
    p.chars = p.chars.filter((c) => c.apps.length > 0);
    return view(p);
  },
  previewUrl: () => "/sample_demo.mp4",
  async startExport(id, req) {
    await delay(200);
    const p = must(id);
    const ch = p.chars.find((c) => c.id === req.characterId);
    if (req.mode === "merged" && req.codec === "copy" && ch) {
      const ids = new Set(req.appearanceIds);
      const used = new Set(ch.apps.filter((a) => ids.has(a.id)).map((a) => a.sourceId));
      const medias = p.sources.filter((s) => used.has(s.id)).map((s) => s.media);
      if (mediaDiffs(medias).length) throw new ApiError("incompatible_sources", "The selected videos do not share the same stream parameters, so they cannot be joined by stream copy.");
    }
    const jobId = `job-${jobSeq++}`;
    const n = req.mode === "merged" ? 4 : Math.min(12, Math.max(3, req.appearanceIds.length / 2));
    jobs.set(jobId, { id: jobId, type: "export", startedAt: Date.now(), perSourceMs: 0, batch: [], freezeBase: 0, freezable: false, durationMs: params.get("exportms") ? Number(params.get("exportms")) : n * 700, cancelled: false, failed: /fail/i.test(req.outputDir) ? "Could not write to the output folder: access denied." : null, projectId: id, req, settled: false });
    return { jobId };
  },
  async getJob(jobId) {
    await delay(40);
    const j = jobs.get(jobId);
    if (!j) throw new ApiError("not_found", "Job not found");
    return jobState(j);
  },
  async cancelJob(jobId) {
    await delay(100);
    const j = jobs.get(jobId);
    if (!j) throw new ApiError("not_found", "Job not found");
    if (j.type === "analysis") {
      advance(j);
      const p = projects.get(j.projectId ?? "");
      if (p) {
        for (const sid of j.batch) {
          const s = srcById(p, sid);
          if (s && (s.status === "queued" || s.status === "analyzing")) s.status = "cancelled";
        }
        if (p.jobId === j.id) p.jobId = null;
      }
    }
    j.cancelled = true;
    j.settled = true;
    return jobState(j);
  },
  async getSettings() { await delay(); return structuredClone(settings); },
  async putSettings(s) { await delay(80); settings = structuredClone(s); return structuredClone(settings); },
  async storage() { await delay(); return { projectsBytes: 86.4e6, modelsBytes: 1.12e9, previewsBytes }; },
  async clearPreviews() { await delay(400); const f = previewsBytes; previewsBytes = 0; return { freedBytes: f }; },
  async openPath() { await delay(80); return { ok: true }; },
};
