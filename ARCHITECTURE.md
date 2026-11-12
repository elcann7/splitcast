# Splitcast — Architecture, API contract and design system

Splitcast is a local Windows desktop app. The user gives it a film or episode;
it finds every person in it, groups their shots, and exports the chosen character's
shots as a "scenepack" for video editors. Think of Topaz Video AI, but instead of
upscaling it cuts a film into per-character clip packs. Everything runs on the
user's machine; nothing is uploaded.

This file is the single source of truth shared by the backend and the frontend.
If code and this file disagree, fix the code or update this file in the same change.

## 1. Target machine and constraints

- Windows 11, RTX 5060 8 GB (Blackwell, driver 610.x), i5-14400F, 16 GB RAM.
- Python 3.12 and Node 24 are installed. Rust is not, so there is no Tauri.
  The desktop shell is pywebview (Edge WebView2).
- ffmpeg is NOT installed system-wide. The app keeps its own copy.
- The project folder lives under OneDrive and its path contains non-ASCII
  characters (`Layihələr`). OpenCV and some native libraries cannot open such
  paths, and OneDrive would sync anything heavy. Therefore everything heavy or
  machine-specific lives in `%LOCALAPPDATA%\ScenepackStudio\` (ASCII, not synced):

  ```
  %LOCALAPPDATA%\ScenepackStudio\
    venv\          Python virtual environment (do not use the global Python packages)
    bin\           ffmpeg.exe, ffprobe.exe
    models\        ONNX weights
    projects\<id>\ project.json, thumbs\, previews\
    tmp\          partial downloads, export scratch (cleaned automatically)
    settings.json
  ```

  The repo holds source only. Never write caches, models or venvs into the repo.
- User video paths may also be non-ASCII. Decode through PyAV or ffmpeg (both
  handle Unicode paths); never hand a user path to `cv2.VideoCapture`/`cv2.imread`.

## 2. Layout

```
backend/            Python package `scenepack` (API server, pipeline, export)
src/                React + TypeScript + Vite + Tailwind frontend
public/             static assets (logo, sample_demo.mp4)
app.py              desktop entry: starts backend, opens pywebview window
setup.ps1           one-time setup: venv, pip deps, ffmpeg, default models
ScenepackStudio.bat double-click launcher (runs setup if needed, then app.py)
```

Backend listens on `127.0.0.1:8756`. In production it also serves the built
frontend from `dist/`. In development Vite runs on `5173` and proxies `/api`
to `8756`.

## 3. AI pipeline

### 3.1 Quality presets (the user-facing choice)

| id         | Label (az)  | Shot detection            | Face detector        | Face recognizer                   | Sampling | Extra |
|------------|-------------|---------------------------|----------------------|-----------------------------------|----------|-------|
| `fast`     | Sürətli     | content-adaptive          | SCRFD-500MF @640     | ArcFace MobileFaceNet (`w600k_mbf`) | 2 fps    | — |
| `balanced` | Balans      | TransNetV2                | SCRFD-10GF @640      | ArcFace R50 (`w600k_r50`)         | 4 fps    | — |
| `max`      | Maksimum    | TransNetV2                | SCRFD-10GF @960      | ArcFace R100 Glint360K (`glintr100`) | 8 fps | flip-augmented embeddings |

Model sources: InsightFace packs `buffalo_s`, `buffalo_l`, `antelopev2`
(`https://github.com/deepinsight/insightface/releases/download/v0.7/<pack>.zip`);
only the detector and recognizer ONNX files are needed from each. Verify each URL
before relying on it. TransNetV2 needs an ONNX export; if no trustworthy one can be
obtained, implement the content-adaptive detector for all presets and keep the
registry slot so TransNetV2 can be dropped in later — say so in the hand-back.

Models live in a registry (`id → files, url, input size, embedding dim`), so a
different recognizer can be swapped in without touching the pipeline. Note for the
owner: InsightFace weights are licensed for non-commercial research use.

Inference runs on ONNX Runtime with the CUDA provider, falling back to CPU when
CUDA cannot be initialised. The fallback must be visible in `/api/system`, not silent.
Batch face crops through the recognizer; do not embed one face per call.

### 3.2 Stages

1. **Probe** — duration, fps, resolution, codecs, audio.
2. **Shots** — cut the film into shots. Shots shorter than 0.4 s merge into a neighbour.
3. **Faces** — sample frames per preset, decode downscaled (long side ≈ detector
   input) but keep the scale factor so boxes map back to source pixels. For every
   detection keep: frame time, box, 5 landmarks, detector score, embedding
   (L2-normalised, from the 112×112 landmark-aligned crop), and a quality score
   (face size, sharpness, frontal-ness from landmark geometry). Drop faces smaller
   than ~40 px in source height or with detector score < 0.5; they produce
   garbage embeddings and are the main cause of bad clusters.
4. **Tracklets** — inside each shot, link detections across consecutive sampled
   frames by box IoU and embedding similarity. A tracklet is one person in one
   shot. Its embedding is the quality-weighted mean of its best faces,
   re-normalised. Tracklets, not single faces, are what gets clustered — this
   is what makes grouping stable. Detections are first filtered: box height
   < 40 px (source), detector score < 0.5, or implausible landmark geometry
   (eyes/nose/mouth out of order or outside the box: machinery and textures
   that SCRFD scores 0.5-0.8) are dropped. Of the rest, a face is *usable*
   (score >= 0.6, |yaw| <= ~35 deg, not blurry) or only *weak* (profile or soft:
   still embedded, never defines an identity). Only usable faces enter a
   tracklet's embedding; a lone single-sample tracklet with score < 0.75 is not
   trusted to seed a cluster either.
5. **Clustering** — agglomerative clustering of tracklet embeddings on cosine
   distance, with a cannot-link constraint: two tracklets that overlap in time
   in the same shot are different people and must never merge. Then a
   refinement pass: recompute centroids, reassign low-quality tracklets to the
   nearest centroid if within threshold, merge clusters whose centroids are
   within the merge threshold and which do not violate cannot-link. Thresholds
   are per recognizer (they differ between MobileFaceNet, R50 and R100) and must
   be tuned on real footage, not guessed. The refinement pass runs for every
   preset (it is cheap and it is what merges a character split by pose/lighting).
   Weak tracklets (profile, blurry, single-sample) are attached last, only to
   clusters backed by >= 2 reliable tracklets, only above a similarity
   threshold with a margin over the runner-up, and never across a cannot-link;
   otherwise they are dropped (they still count towards `peopleCount`).
6. **Characters** — each cluster is a character. Rank by screen time. Clusters
   with very little screen time (< 3 appearances and < 4 s) are flagged
   `isMinor` (extras). The character thumbnail is its highest-quality face crop
   (square, with margin). One appearance = one character in one shot.

An appearance spans the whole shot (`start`/`end` are the shot's boundaries);
`screenTime` sums the time the character is actually tracked inside those shots.

Analysis is cancellable and reports progress per stage. A re-scan with another
preset replaces the project's analysis but keeps the project.

### 3.3 Export

ffmpeg, per appearance or merged into one file:

- `copy` — stream copy, instant, cuts snap to keyframes (not frame accurate; a clip
  starts up to one GOP early). The container follows the source: `.mp4` when
  the codecs fit, otherwise `.mkv` (`.mov` for ProRes), so the extension of
  copy-mode files is not always `.mp4`.
- `h264` / `hevc` — frame-accurate re-encode. Use NVENC when available
  (`/api/system` reports it), else libx264/libx265. Quality levels:
  `high` (visually lossless, e.g. CQ/CRF ≈ 16) and `master` (≈ 12).
- `prores` — ProRes 422 HQ `.mov` for editors who want an intermediate codec.

Options: audio on/off, padding before/after each clip (ms), join adjacent
shots of the same character into one clip, file naming
`<Title> - <Character> - 001.mp4`. Source resolution and frame rate are
preserved. Output goes to `<outputDir>\<Title>\<Character>\`.

## 4. HTTP API (JSON, camelCase)

Errors: non-2xx with `{ "error": { "code": string, "message": string } }`.
All times are seconds (float) unless a field name ends in `Ms`.
Image/preview fields are absolute-path URLs (`/api/...`) usable directly in `src`.

```
GET    /api/system                     → SystemInfo
POST   /api/models/download            {preset} → {jobId}
POST   /api/dialog/open-video          → {path: string|null}     native file dialog
POST   /api/dialog/choose-folder       → {path: string|null}
POST   /api/probe                      {path} → MediaInfo
GET    /api/projects                   → ProjectSummary[]
POST   /api/projects                   {path, title?, preset} → {projectId, jobId}
GET    /api/projects/{id}              → Project
PATCH  /api/projects/{id}              {title} → Project
DELETE /api/projects/{id}              → {ok: true}
POST   /api/projects/{id}/rescan       {preset} → {jobId}
PATCH  /api/projects/{id}/characters/{cid}        {name?, hidden?} → Project
POST   /api/projects/{id}/characters/merge        {sourceIds: string[], targetId} → Project
POST   /api/projects/{id}/appearances/move        {appearanceIds: string[], targetCharacterId: string|"new"} → Project
GET    /api/projects/{id}/appearances/{aid}/preview.mp4   H.264/AAC proxy clip (≤720p), built lazily and cached, Range-capable
GET    /api/projects/{id}/thumbs/{file}
POST   /api/projects/{id}/export       ExportRequest → {jobId}
GET    /api/jobs/{jobId}               → Job
POST   /api/jobs/{jobId}/cancel        → Job
GET    /api/settings                   → Settings
PUT    /api/settings                   Settings → Settings
GET    /api/storage                    → {projectsBytes, modelsBytes, previewsBytes}
POST   /api/storage/clear-previews     → {freedBytes}
POST   /api/open-path                  {path} → {ok: true}       reveal in Explorer
```

The preview clip covers the appearance plus 2 s of handle on each side (clamped
to the file), so the user can trim outward. `Appearance.previewOffset` is where
the appearance starts inside that preview clip.

`GET /api/projects/{id}/thumbs/{file}` accepts a sub-path: live face thumbnails
during analysis are served as `thumbs/live/<file>` (and deleted when the analysis
ends). A failed project carries an extra optional `error: string` field.
`Job.speedFps` is source video frames per second processed (media fps x
realtime multiple). `POST /api/models/download` creates a `download` job; an
analysis whose preset is not installed downloads first (stage `download`).
Dropped files: see section 6.

```ts
type PresetId = "fast" | "balanced" | "max";

interface SystemInfo {
  version: string;
  device: { provider: "cuda" | "cpu"; gpuName: string | null; vramMb: number | null; note: string | null };
  ffmpeg: { ok: boolean; version: string | null; nvenc: boolean };
  presets: Preset[];
  paths: { data: string; defaultExportDir: string };
}
interface Preset {
  id: PresetId;
  shotDetector: string;      // human-readable model names for the UI
  faceDetector: string;
  faceRecognizer: string;
  sampleFps: number;
  installed: boolean;        // all weights present
  downloadMb: number;        // remaining download size, 0 when installed
  speedFactor: number;       // rough processing speed as a multiple of realtime on this device
}
interface MediaInfo {
  path: string; fileName: string; sizeBytes: number;
  duration: number; width: number; height: number; fps: number;
  videoCodec: string; audioCodec: string | null; hasAudio: boolean;
}
interface ProjectSummary {
  id: string; title: string; createdAt: string;           // ISO 8601
  status: "analyzing" | "ready" | "failed" | "cancelled";
  preset: PresetId; duration: number;
  poster: string | null; characterCount: number; activeJobId: string | null;
}
interface Project extends ProjectSummary {
  media: MediaInfo;
  sourceMissing: boolean;    // the video file is no longer at media.path
  stats: { shotCount: number; faceCount: number; analysisSeconds: number } | null;
  characters: Character[];   // sorted by screenTime, descending
}
interface Character {
  id: string; name: string;  // default "Personaj 01", "Personaj 02", …
  thumb: string; hidden: boolean; isMinor: boolean;
  screenTime: number; appearanceCount: number;
  appearances: Appearance[]; // sorted by start
}
interface Appearance {
  id: string; shotIndex: number;
  start: number; end: number;
  thumb: string;             // frame from this shot where the character's face is best
  previewOffset: number;
  shotSize: "closeup" | "medium" | "wide";   // from face height relative to frame height
  solo: boolean;             // no other tracked person in the shot
  peopleCount: number;
  coverage: number;          // 0–1, share of the shot's sampled frames where the character is visible
  confidence: number;        // 0–1, similarity of this tracklet to the character centroid
}
interface Job {
  id: string; type: "analysis" | "export" | "download";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number;          // 0–1 overall
  stage: "probe" | "shots" | "faces" | "cluster" | "finalize" | "export" | "download";
  message: string | null;    // short machine-ish detail, e.g. "shot 412 / 1558"
  speedFps: number | null; etaSeconds: number | null;
  recentFaces: string[];     // up to 12 thumb URLs found most recently (analysis only)
  counts: { shots: number; faces: number; characters: number } | null;
  error: string | null;
  result: { projectId?: string; outputDir?: string; files?: string[] } | null;
}
interface ExportRequest {
  characterId: string;
  appearanceIds: string[];
  trims: Record<string, { start: number; end: number }>;   // absolute source times, overrides per appearance
  mode: "clips" | "merged";
  codec: "copy" | "h264" | "hevc" | "prores";
  quality: "high" | "master";
  audio: boolean;
  paddingMs: number;
  joinAdjacent: boolean;
  outputDir: string;
}
interface Settings {
  language: "az" | "en" | "tr" | "ru" | "uk" | "de" | "fr" | "es" | "pt" | "it" | "pl" | "zh" | "ja" | "ko" | "ar" | "hi";
  defaultPreset: PresetId;
  exportDir: string;
  export: Omit<ExportRequest, "characterId" | "appearanceIds" | "trims" | "outputDir">;
}
```

The frontend polls `GET /api/jobs/{id}` every 500 ms while a job is running.

## 5. Product design

### 5.1 Principles

The footage is the only colourful thing on screen. The interface is neutral, dense
and calm like a professional editing tool (Resolve, Premiere), not a marketing
page: no gradients, no glow, no glassmorphism, no blur, no coloured badges, no
emoji, no decorative icons. One accent colour, used only for the primary action
and for selection. Desktop layout only (min window 1180×720), never a phone frame.

### 5.2 Tokens

```
surface-0  #0E0E0F   app background
surface-1  #151516   panels, sidebar
surface-2  #1C1C1E   cards, inputs, secondary buttons
surface-3  #262628   hover / pressed
line       #2A2A2D   hairlines
line-strong#3A3A3E   input borders, focused dividers
text-1     #EDEDEA   primary
text-2     #A3A39E   secondary
text-3     #6E6E6A   tertiary, placeholders
accent     #E9A23B   tungsten amber — primary button fill, selection ring, playhead, progress
accent-hi  #F2B354   hover
on-accent  #1A1204   text on accent
accent-dim rgba(233,162,59,0.14)  selected row background
danger     #E5645A   destructive text/icon only
ok         #6FBF8B   completion mark only
```

- Type: Geist Variable for UI, Geist Mono for timecodes, durations and counts
  (tabular). Bundle the fonts locally (`@fontsource-variable/geist`,
  `@fontsource-variable/geist-mono`); the app works offline.
  Sizes: 12 meta · 13 body · 15 section title · 20 page title. Weights 400/500/600.
  No all-caps labels except the tiny mono stage markers.
- Radius: 6 controls, 8 thumbnails and cards, 12 dialogs. Borders are 1 px `line`.
- Shadow only on floating layers (menus, dialogs): `0 12px 32px rgba(0,0,0,.5)`.
- Motion (`index.css`, "motion" block): movement explains what happened —
  something arrived, was picked, is working — and never decorates. Transform
  and opacity only. Screens rise in (340 ms); list items (library cards, cast
  rows) arrive staggered; dialogs scale in; thumbnails fade in when loaded and
  zoom slightly on hover; the selection check pops; the segmented control's
  highlight slides; running progress bars carry a moving sheen; the running
  analysis step shimmers; counts run up to their value. Hover and press
  feedback is 140 ms. No glow, no parallax, no cursor effects, no background
  animation. `prefers-reduced-motion` turns all of it off.
- Controls are 32 px high (28 px compact). Primary = accent fill with `on-accent`
  text. Secondary = `surface-2` with `line-strong` border. Ghost = text only,
  `surface-3` on hover. Focus-visible: 2 px accent ring.
- Icons: lucide, 16 px, stroke 1.5, `text-2`.

### 5.3 Screens

1. **Library** (home). Left rail (56 px): logo mark, Library, Settings. Main:
   page title, "Yeni layihə" primary button, and a grid of project cards (16:9
   poster frame, title, duration · character count · preset in mono meta). The
   whole window is a drop target for a video file. Empty state: one centred
   drop zone with a single sentence and the button — no illustration.
2. **New project** (dialog after a file is chosen). Shows the probed file facts
   in one mono line (name · 1920×1080 · 23.976 fps · 1:52:10 · H.264), an
   editable title, and the quality preset as three selectable rows — each row:
   name, one-line plain description of the trade-off, the model names in mono,
   and the estimated time for this file on this device (duration ÷ speedFactor).
   If a preset's models are not installed, the row says the download size and
   starting the analysis downloads them first. Buttons: Ləğv et / Analizə başla.
3. **Analysis**. Full-page, quiet. Title, a four-step horizontal stage line
   (Kadrlar · Üzlər · Qruplaşdırma · Yekun) with the current step in accent, one
   thin progress bar, a mono line with speed and ETA, the running counts, and a
   strip of the most recent face thumbnails streaming in. Cancel button.
4. **Project workspace** — the core screen, three regions:
   - **Cast panel** (left, 280 px): characters as rows — 44 px square face,
     name (double-click to rename), screen time and appearance count in mono.
     Multi-select with Ctrl/Shift, then "Birləşdir" merges them. A collapsed
     "Epizodik (n)" group holds `isMinor` characters. Hide/unhide per character.
   - **Scenes** (centre): header with the character name, total selected
     duration, and filters — shot size (Hamısı / Yaxın / Orta / Ümumi), "Yalnız
     tək" (solo), minimum duration, sort (time / duration / confidence). A dense
     grid of 16:9 scene thumbnails; each shows start timecode and duration in
     mono, and is selectable (click toggles, Shift range, Ctrl+A all).
     Selected = accent ring. Hovering a thumbnail scrubs/plays its preview.
     Right-click or a toolbar action: "Başqa personaja köçür" (move appearance).
     Below the grid, a full-width **appearance track**: one thin bar the length
     of the film with a tick for every appearance of the current character;
     clicking a tick scrolls to that scene.
   - **Inspector** (right, 360 px): preview player for the focused scene with
     in/out trim handles on a small timeline, timecodes, shot facts (size,
     solo/people count, confidence), keyboard: Space play, I/O set in/out,
     ←/→ previous/next scene.
   - Top bar: back to library, project title (editable), source facts in mono,
     "Yenidən skan et" (choose another preset), and the primary
     "Eksport (n səhnə)" button.
5. **Export** (dialog, then a progress view in the same dialog). Mode
   (ayrı kliplər / tək fayl), codec (Orijinal axın / H.264 / HEVC / ProRes) with
   a one-line consequence under each (e.g. copy = instant but cuts at
   keyframes), quality, audio, padding, join adjacent, destination folder with a
   browse button, and a summary line (n clips · total duration). After start:
   progress, then "Qovluğu aç".
6. **Settings**. Device and engine status (GPU name, CUDA or CPU, ffmpeg,
   NVENC), installed models per preset with download buttons, default preset,
   default export options, storage use with "Önbaxış keşini təmizlə", language.

Every screen has loading, empty and error states. Errors say what failed and
what the user can do, in plain language.

### 5.4 Language

16 interface languages, each shown by its own name in Settings (a custom Select):
az (default), en, tr, ru, uk, de, fr, es, pt, it, pl, zh, ja, ko, ar, hi.
`src/i18n/dict.ts` holds `az` (the source of the `Key` type) and `en`; every other
language is one file in `src/i18n/langs/<code>.ts` typed `Record<Key, string>`, so a
missing or misspelled key fails `tsc`. Lookup order: language, then `en`, then `az`.
`LANGS` in `src/i18n/index.ts` is the single list (code, native name, rtl, plural order);
the backend whitelist is `LANGUAGES` in `backend/scenepack/settings.py` and must match.

Plurals: a value `"a|b|c"` is picked with `Intl.PluralRules(lang)` using the category
order in `LANGS[].plural` (en/de/fr/es/pt/it/tr/hi: one|other; ru/uk/pl: one|few|many;
CJK and az: a single form). Arabic avoids agreement with the "label: {n}" form.
Right-to-left: `applyDocLang` sets `<html lang dir>`; `.mono` text and the appearance
timeline stay left-to-right. To add a language: add the file, export it from
`langs/index.ts`, add it to `LANGS`, `dicts` and the backend whitelist.

Azerbaijani copy is plain and short, in the Latin alphabet with correct diacritics
(ə, ı, ö, ü, ş, ç, ğ).

## 6. Dropping a video onto the window (desktop shell)

A DOM `File` has no path, and pywebview does **not** put `pywebviewFullPath` on
the `File` objects the page sees; it only exposes it to Python-side handlers.
`app.py` therefore registers a Python `drop` handler on the document and, when
files with real paths arrive, dispatches a window event into the page:

```ts
window.addEventListener("scenepack:file-drop", (e) => {
  const paths: string[] = (e as CustomEvent<{ paths: string[] }>).detail.paths; // absolute Windows paths
});
```

`app.py` also injects a window-level `dragover`/`drop` `preventDefault()`, so
the page needs no extra work for the drop to be accepted (it may still add its
own `dragenter`/`dragleave` handlers for a highlight). In a plain browser
(Vite dev without pywebview) no such event fires; use the native dialog
endpoint instead.

## 7. Multi-video projects (seasons) — supersedes §3–§5 where they conflict

A project is a title — one film, or a whole season — and holds one or more
videos ("sources", e.g. episodes). Each source is analysed on its own, but
characters belong to the project: the same person in episode 1 and episode 7
is ONE character, so a single export produces that character's scenepack for
the whole season. This is the point of the feature; a project where every
episode yields its own unrelated "Personaj 01" is a failure.

Status: implemented (backend `identity.py`, `scans.py`, `pipeline.py` runner,
`export.py`; frontend workspace, Videolar panel, sectioned scene grid). Where
§3–§5 still describe a single-video project, this section is the truth.

Implementation notes that differ from or add to the text below:

- `project.json` is version 2: `sources`, `characters` (identity only),
  `assign` (tracklet → character per source, with a `pinned` flag for manual
  moves) and `separate` (pairs the user split, never auto-merged). Evidence
  (tracklet metadata + embeddings) lives in `scans/<token>.json|npz`.
  Appearances are derived from `assign`, never stored.
- Version 1 projects are migrated on load (backup `project.v1.json`). They
  have no embeddings, so their source carries `needsRescan` + a `notice`; the
  first time another video is added it is re-scanned first and its names,
  hidden flags and merges are carried over by time overlap.
- A whole-project re-scan with another preset carries names and hidden flags
  over; manual splits and moves are not carried (the tracklets are new).
- `Source` also returns `needsRescan`, `notice` and `progress` (0–1 while
  analysing). `POST …/sources` also returns `skipped` (paths already in the
  project). Export results carry `skipped` (appearances whose file is gone).
- The cast row shows `time · n səhnə · s/total` (the word "video" did not fit
  the 280 px panel); the scenes header shows the full `s/total video`.
- Test servers: `SCENEPACK_PORT` and `SCENEPACK_PROJECTS_DIR` run a second
  instance without touching the real library.

### 7.1 Identity across videos

- A project has exactly one preset. Embeddings from different recognizers are
  not comparable, so all sources of a project use the same recognizer.
- Each source goes through §3.2 stages 1–5 on its own (shots, faces, tracklets,
  within-video clustering with cannot-link).
- Then its clusters are matched against the project's existing characters:
  compare the cluster's embedding with each character's identity embeddings
  (keep several exemplars / per-source centroids per character rather than one
  global mean, so a character whose look changes across episodes still
  matches) and attach when similarity clears a per-recognizer match threshold
  with a margin over the runner-up. Otherwise the cluster becomes a new
  character. Two clusters of the same source may land on the same character
  only if they never co-occur in a shot. The match threshold must be tuned on
  real multi-video footage; a false merge of two different people is worse
  than a missed match, because the user can merge in one click but cannot
  easily un-merge.
- The result must not depend on the order of the videos more than necessary:
  after a source is added, run a project-level refinement that merges
  characters whose identity embeddings are now clearly the same person
  (respecting cannot-link within each source and never undoing a manual
  split or move made by the user).
- User edits are identity too and survive everything: names, hidden flags,
  manual merges and manual appearance moves are preserved when a source is
  added, removed, or re-scanned. A character the user merged keeps the
  exemplars of all its parts, so later episodes match either look.
- Persist per-tracklet embeddings per source (compact, in the project folder)
  so matching, refinement and merges can be recomputed without re-decoding video.
- `isMinor` is computed on project totals (an extra in episode 1 may be a
  lead by episode 5). Default names are numbered at creation and never
  renumbered afterwards.
- Re-scan of one source (same preset): drop that source's appearances,
  re-analyse, match again against the existing characters.
- Re-scan of the whole project with another preset: every source is
  re-analysed and characters are rebuilt; carry names and hidden flags over to
  the new characters by voting on time overlap of appearances per source.
- Existing single-video projects on disk are migrated to this model on load
  (one source), without re-analysis where the stored data allows it; if the
  stored data lacks embeddings, the project still opens and its source is
  marked so that adding another video first re-scans it (tell the user why).

### 7.2 Sources and jobs

- Sources are analysed one after another by the project's analysis job.
  Adding videos while an analysis is running queues them behind it.
- The project is usable as soon as its first source is ready: the workspace
  opens and further sources keep analysing in the background, with new
  characters and appearances showing up as each source finishes. The full-page
  Analysis screen is only shown while no source is ready yet.
- Cancelling stops the current source and marks it and all queued ones
  `cancelled`; each can be retried individually. One failed source does not
  stop the queue.
- A video already in the project (same path) is not added twice.

### 7.3 API changes

```
POST   /api/dialog/open-video                    → {paths: string[]}        multi-select; [] when cancelled
POST   /api/projects                             {paths: string[], title?, preset} → {projectId, jobId}
POST   /api/projects/{id}/sources                {paths: string[]} → {jobId, sourceIds: string[]}
PATCH  /api/projects/{id}/sources/{sid}          {label} → Project
DELETE /api/projects/{id}/sources/{sid}          → Project   removes its appearances; characters left with none are removed
POST   /api/projects/{id}/sources/{sid}/rescan   → {jobId}   same preset
POST   /api/projects/{id}/rescan                 {preset} → {jobId}   all sources
```

```ts
interface Source {
  id: string;
  label: string;             // default: file name without extension
  order: number;             // sources are ordered by natural sort of label at creation, later additions go last
  media: MediaInfo;
  status: "queued" | "analyzing" | "ready" | "failed" | "cancelled";
  sourceMissing: boolean;
  error: string | null;
  stats: { shotCount: number; faceCount: number; analysisSeconds: number } | null;
  poster: string | null;
}
interface ProjectSummary {
  id: string; title: string; createdAt: string;
  status: "analyzing" | "ready" | "failed" | "cancelled";   // ready as soon as one source is ready; analyzing only while none is
  preset: PresetId;
  duration: number;          // sum over sources
  sourceCount: number; readySourceCount: number;
  poster: string | null; characterCount: number;
  activeJobId: string | null;   // the running/queued analysis job, even when status is "ready"
}
interface Project extends ProjectSummary {
  sources: Source[];         // sorted by order. (Project.media, Project.sourceMissing and Project.stats are removed)
  error?: string | null;
  characters: Character[];
}
interface Character {        // adds:
  sourceCount: number;       // in how many sources the character appears
}
interface Appearance {       // adds:
  sourceId: string;          // start/end are times inside that source
}
// Character.appearances are sorted by source order, then start.
interface Job {              // adds (analysis jobs):
  sourceId: string | null;   // source being processed now
  sourceIndex: number;       // 1-based position within this job's batch
  sourceCount: number;       // batch size; grows when sources are queued behind it
  // progress is overall across the batch; stage/message/speedFps describe the current source
}
```

`ExportRequest` is unchanged; appearance ids are unique within a project and
may come from several sources. Export rules across sources:

- `clips`: files are named `<Character> - <SourceLabel> - 001.<ext>`, numbered
  per source, in `<outputDir>\<Title>\<Character>\`.
- `merged`: one file in source order, then time order. When the selected
  sources differ in resolution, frame rate or audio layout, the output is
  conformed to the first selected source (scale to fit with letterbox, fps
  conversion, audio resample) — never stretched. `copy` + `merged` across
  sources whose streams are not identical is refused with error code
  `incompatible_sources`; the frontend disables that combination up front by
  comparing the `media` of the sources involved and says why.
- `joinAdjacent` never joins across sources.
- A source with `sourceMissing` contributes no clips; the export reports how
  many were skipped rather than failing.

The desktop drop event carries every dropped path
(`scenepack:file-drop`, `detail.paths: string[]`).

### 7.4 UI changes

- **Library card**: title, then mono meta `8 video · 5:42:10 · 23 personaj`.
  While sources are still analysing, the card shows `3/8` and a thin progress line.
- **New project dialog**: accepts several files. Shows them as a compact list
  (label · resolution · fps · duration · codec, each removable, with a row to
  pick more), the editable title (default: the common prefix of the file
  names, or the folder name), and the preset rows with the estimate computed
  over the total duration. Dropping files on the Library opens this dialog
  with all of them.
- **Workspace top bar**: a "Videolar (n)" button opens a panel listing the
  sources in order — label (rename inline), duration, status (ready /
  analysing with percent / queued / failed with the reason / file missing),
  actions: yenidən skan et, sil — and "Video əlavə et". Dropping video files
  on the workspace adds them to this project.
- **Background analysis strip**: while the project is usable and more sources
  are analysing, a slim one-line strip under the top bar shows
  `Video 3/8 analiz olunur · <label> · 42%` with a cancel action. When a
  source finishes, the cast and scenes update in place without losing the
  selection, trims, focus or scroll position.
- **Cast row**: second line becomes `12:40 · 86 səhnə · 7/8 video`.
- **Scenes grid**: appearances are grouped by source under a thin sticky
  section header (label · scene count · selected count; clicking the header
  selects/deselects that source's scenes). A source filter (Hamısı / one
  source) joins the existing filters. Timecodes on tiles stay source-relative.
  With a single source the grid looks exactly as before (no header).
- **Appearance track**: the sources are laid end to end proportionally to
  their duration with hairline separators and the label under each segment
  (truncate; full label on hover).
- **Inspector**: shows the source label next to the timecodes.
- **Export dialog**: the summary line reads `n klip · m video · total
  duration`; the copy+merged restriction above is explained inline.
- **Re-scan dialog**: changing the preset says plainly that all n videos will
  be analysed again and gives the total estimate.

## 8. Anime content

ArcFace and SCRFD are trained on real faces; on drawn characters they miss
faces and cannot tell people apart. A project therefore has a content kind,
chosen in the New project dialog: `live` (default) or `anime`. The kind picks
the engine (`faces.make_engine`); tracking, clustering, identity across
videos, the job system and export are shared.

| Preset     | Shots            | Detector (deepghs, MIT)        | Recognizer (deepghs CCIP, OpenRAIL) | Sampling |
|------------|------------------|--------------------------------|--------------------------------------|----------|
| `fast`     | content-adaptive | anime_face_detection v1.4 n @640 | ccip-caformer-24-randaug-pruned    | 1.5 fps  |
| `balanced` | TransNetV2       | anime_face_detection v1.4 s @640 | same                                | 3 fps    |
| `max`      | TransNetV2       | anime_face_detection v1.4 s @960 | same                                | 6 fps    |

- The detector gives boxes only (no landmarks). The recognizer is fed the
  whole head — the face box grown upwards and sideways to take in the hair —
  at 384×384, because drawn characters differ by hair and eyes, not by facial
  geometry. Features are 768-d; CCIP's published "difference" is exactly
  `(1 − cosine) / 2`, so cosine similarity plugs into the same code.
- CCIP is heavy (~40 crops/s on the RTX 5060), so at most 6 faces per sampled
  frame are embedded and sampling is sparser than for live action.
- Thresholds are on another scale than ArcFace (`registry._CCIP`). Measured on
  one full episode (Blue Lock ep. 1): tracklet to own centroid ≈ 0.90; two
  clusters of the same lead 0.87–0.94; different leads 0.36–0.70; generic
  background extras reach 0.9 among themselves.
- `Thresholds.conflict_tol` (0 for live, 0.08 for anime): two large,
  near-identical clusters may merge although a few of their tracklets share a
  frame. Drawn shows put a character on screen twice (split panels, memories,
  reflections), and strict cannot-link kept the lead split in three.
- `isMinor` for anime is `appearances < 6 or screenTime < 15 s`: crowds yield
  dozens of small background clusters, which belong in the collapsed group.
- Known limits: background extras with a generic design get mixed with each
  other; a lead may still leave one or two small stray clusters to merge by
  hand; tuned on one episode of one show.

API: `Preset.content`, `ProjectSummary.content`; `POST /api/projects` and
`POST /api/models/download` take `content` (default `live`). `/api/system`
lists the presets of both kinds; the UI filters by the chosen kind.

## 9. Marketing site and README

`site/` is a static page (HTML, CSS, JS, no build) deployed to GitHub Pages by `.github/workflows/pages.yml`. Screenshots in `site/shots` are real captures of the app (Tears of Steel, CC-BY; no copyrighted anime footage) and are reused by `README.md`. Set `REPO` at the top of `site/main.js` and the clone URL in `README.md` once the repository exists.


## 10. Installer

`installer/build.ps1` builds `installer/Output/Splitcast-Setup-<version>.exe` (Inno Setup 6, per-user, no admin). It is self-contained: embedded Python 3.12 + pip, all of `backend/requirements.txt` (onnxruntime-gpu with the CUDA libraries, ~2.3 GB unpacked), the built UI, ffmpeg and the Balanced model pack (staged as the user data folder `%LOCALAPPDATA%\Splitcast\{bin,models}`, `onlyifdoesntexist`, kept on uninstall). Result: ~1.5 GB (GitHub's per-file limit is 2 GiB; keep an eye on it when dependencies grow). Fast, Maximum and anime packs download on demand from the app.

- `Splitcast.exe` is `pythonw.exe` renamed, with our icon (rcedit), so Task Manager and the taskbar show Splitcast. It runs `app\app.py`.
- The embedded `python312._pth` lists `..\app\backend`: embedded Python ignores `PYTHONPATH` when a `._pth` file exists.
- Data folder: `paths.py` uses `%LOCALAPPDATA%\Splitcast`, or the old `ScenepackStudio` folder when it already holds projects and the new one does not (dev machines).
- WebView2 runtime is downloaded only if Windows lacks it. "Repair components" (Start menu) runs `install_components.cmd` (pip + `scenepack.bootstrap`).
- `.github/workflows/release.yml` builds it on a `v*` tag and attaches it to the release. Not code-signed yet (SmartScreen notice).
- Verified on this machine: silent install in 116 s, CUDA provider, bundled models detected, a 5-minute film analysed end to end (10 characters, 66 s).
