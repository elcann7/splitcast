import type { Lang } from "../i18n";
// Types mirror ARCHITECTURE.md sections 4 and 7.3 exactly. Do not rename fields.

export type PresetId = "fast" | "balanced" | "max";
/** What the footage is: real people, or drawn characters (another detector and recognizer). */
export type ContentKind = "live" | "anime";

export interface SystemInfo {
  version: string;
  device: { provider: "cuda" | "dml" | "cpu"; gpuName: string | null; vramMb: number | null; note: string | null };
  ffmpeg: { ok: boolean; version: string | null; nvenc: boolean; encoder: "nvenc" | "amf" | "qsv" | null };
  presets: Preset[];
  paths: { data: string; defaultExportDir: string };
}

export interface Preset {
  id: PresetId;
  content: ContentKind;
  shotDetector: string;
  faceDetector: string;
  faceRecognizer: string;
  sampleFps: number;
  installed: boolean;
  downloadMb: number;
  speedFactor: number;
}

export interface MediaInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
}

export type SourceStatus = "queued" | "analyzing" | "ready" | "failed" | "cancelled";

/** One video of a project (an episode, or the film itself). */
export interface Source {
  id: string;
  label: string;
  order: number;
  media: MediaInfo;
  status: SourceStatus;
  sourceMissing: boolean;
  error: string | null;
  stats: { shotCount: number; faceCount: number; analysisSeconds: number } | null;
  poster: string | null;
  /** analysed by an older version without identity data: re-scanned before another video is matched */
  needsRescan?: boolean;
  notice?: string | null;
  /** 0..1 while this source is being analysed */
  progress?: number | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  /** "ready" as soon as one source is ready; "analyzing" only while none is. */
  status: "analyzing" | "ready" | "failed" | "cancelled";
  preset: PresetId;
  content: ContentKind;
  /** sum over sources */
  duration: number;
  sourceCount: number;
  readySourceCount: number;
  poster: string | null;
  characterCount: number;
  /** the running/queued analysis job, even when status is "ready" */
  activeJobId: string | null;
}

export interface Project extends ProjectSummary {
  /** sorted by `order` */
  sources: Source[];
  /** Why the analysis failed; survives a restart, unlike the in-memory job. */
  error?: string | null;
  characters: Character[];
}

export interface Character {
  id: string;
  name: string;
  thumb: string;
  hidden: boolean;
  isMinor: boolean;
  screenTime: number;
  appearanceCount: number;
  /** in how many sources the character appears */
  sourceCount: number;
  /** sorted by source order, then start */
  appearances: Appearance[];
}

export type ShotSize = "closeup" | "medium" | "wide";

export interface Appearance {
  id: string;
  /** start / end are times inside this source */
  sourceId: string;
  shotIndex: number;
  start: number;
  end: number;
  thumb: string;
  previewOffset: number;
  shotSize: ShotSize;
  solo: boolean;
  peopleCount: number;
  coverage: number;
  confidence: number;
}

export type JobStage = "probe" | "shots" | "faces" | "cluster" | "finalize" | "export" | "download";

export interface Job {
  id: string;
  type: "analysis" | "export" | "download";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;
  stage: JobStage;
  message: string | null;
  speedFps: number | null;
  etaSeconds: number | null;
  recentFaces: string[];
  counts: { shots: number; faces: number; characters: number } | null;
  error: string | null;
  /** analysis jobs: the source being processed now */
  sourceId: string | null;
  /** 1-based position within this job's batch */
  sourceIndex: number;
  /** batch size; grows when sources are queued behind the job */
  sourceCount: number;
  result: { projectId?: string; outputDir?: string; files?: string[]; skipped?: number } | null;
}

export type ExportMode = "clips" | "merged";
export type ExportCodec = "copy" | "h264" | "hevc" | "prores";
export type ExportQuality = "high" | "master";

export interface ExportRequest {
  characterId: string;
  appearanceIds: string[];
  trims: Record<string, { start: number; end: number }>;
  mode: ExportMode;
  codec: ExportCodec;
  quality: ExportQuality;
  audio: boolean;
  paddingMs: number;
  joinAdjacent: boolean;
  outputDir: string;
}

export type ExportOptionsT = Omit<ExportRequest, "characterId" | "appearanceIds" | "trims" | "outputDir">;

export interface Settings {
  language: Lang;
  defaultPreset: PresetId;
  exportDir: string;
  export: ExportOptionsT;
}

export interface StorageInfo {
  projectsBytes: number;
  modelsBytes: number;
  previewsBytes: number;
}

/** Error thrown by every Api implementation. */
export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The one interface the app codes against. Real and mock both implement it. */
export interface Api {
  readonly mock: boolean;
  system(): Promise<SystemInfo>;
  downloadModels(preset: PresetId, content: ContentKind): Promise<{ jobId: string }>;
  /** multi-select; paths is [] when cancelled */
  openVideoDialog(): Promise<{ paths: string[] }>;
  chooseFolder(): Promise<{ path: string | null }>;
  probe(path: string): Promise<MediaInfo>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(body: { paths: string[]; title?: string; preset: PresetId; content: ContentKind }): Promise<{ projectId: string; jobId: string }>;
  getProject(id: string): Promise<Project>;
  renameProject(id: string, title: string): Promise<Project>;
  deleteProject(id: string): Promise<{ ok: true }>;
  /** Re-analyse every source, possibly with another preset. */
  rescan(id: string, preset: PresetId): Promise<{ jobId: string }>;
  addSources(id: string, paths: string[]): Promise<{ jobId: string; sourceIds: string[] }>;
  patchSource(id: string, sid: string, body: { label: string }): Promise<Project>;
  deleteSource(id: string, sid: string): Promise<Project>;
  /** Re-analyse one source with the project's preset. */
  rescanSource(id: string, sid: string): Promise<{ jobId: string }>;
  patchCharacter(id: string, cid: string, body: { name?: string; hidden?: boolean }): Promise<Project>;
  mergeCharacters(id: string, body: { sourceIds: string[]; targetId: string }): Promise<Project>;
  moveAppearances(id: string, body: { appearanceIds: string[]; targetCharacterId: string | "new" }): Promise<Project>;
  /** URL of the H.264/AAC proxy clip for an appearance. */
  previewUrl(projectId: string, appearanceId: string): string;
  startExport(id: string, req: ExportRequest): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<Job>;
  cancelJob(jobId: string): Promise<Job>;
  getSettings(): Promise<Settings>;
  putSettings(s: Settings): Promise<Settings>;
  storage(): Promise<StorageInfo>;
  clearPreviews(): Promise<{ freedBytes: number }>;
  openPath(path: string): Promise<{ ok: true }>;
}
