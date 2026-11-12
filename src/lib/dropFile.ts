// Everything about turning a dropped file into a path lives here, so it can be
// adjusted when the desktop shell is integrated.
//
// Browsers never expose the full path of a dropped file. pywebview (WebView2) can
// attach it as `pywebviewFullPath` on the dropped File object. When it is absent the
// caller falls back to the native "open video" dialog.

const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm|m4v|ts|m2ts|mts|wmv|flv|mpg|mpeg|ogv|3gp)$/i;

export type DropResult =
  | { kind: "none" }
  | { kind: "notVideo"; name: string }
  /** every dropped video, plus how many dropped files were not videos */
  | { kind: "paths"; paths: string[]; skipped: number }
  | { kind: "needDialog" };

/** True inside the pywebview desktop shell, which injects `window.pywebview`. */
export function inShell(): boolean {
  return "pywebview" in window;
}

const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * The shell cannot put the full path on the DOM File, so `app.py` reads it on the
 * Python side and dispatches `scenepack:file-drop` with every dropped absolute path.
 */
export function onShellDrop(cb: (r: DropResult) => void): () => void {
  const handler = (e: Event) => {
    const all = (e as CustomEvent<{ paths?: string[] }>).detail?.paths ?? [];
    if (!all.length) return;
    const videos = all.filter((p) => VIDEO_EXT.test(nameOf(p)));
    cb(videos.length ? { kind: "paths", paths: videos, skipped: all.length - videos.length } : { kind: "notVideo", name: nameOf(all[0]) });
  };
  window.addEventListener("scenepack:file-drop", handler);
  return () => window.removeEventListener("scenepack:file-drop", handler);
}

export function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

type PathFile = File & { pywebviewFullPath?: string; path?: string };

export function readDrop(e: DragEvent): DropResult {
  const files = Array.from(e.dataTransfer?.files ?? []) as PathFile[];
  if (files.length === 0) return { kind: "none" };
  const videos = files.filter((f) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name));
  if (!videos.length) return { kind: "notVideo", name: files[0].name };
  const full = videos.map((f) => f.pywebviewFullPath || f.path); // `path` for Electron-like shells
  if (full.every((p) => p && /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(p))) {
    return { kind: "paths", paths: full as string[], skipped: files.length - videos.length };
  }
  return { kind: "needDialog" };
}
