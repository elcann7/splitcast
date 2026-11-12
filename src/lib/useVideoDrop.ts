import { useEffect, useRef, useState } from "react";
import { useApp } from "../store/app";
import { useT } from "../i18n";
import { hasFiles, inShell, onShellDrop, readDrop } from "./dropFile";
import type { DropResult } from "./dropFile";

/**
 * Makes the whole window a drop target for video files. `onPaths` receives every dropped
 * video; `onPick` is the fallback when the browser hides the paths (plain browser, no
 * desktop shell). Returns true while files are being dragged over the window.
 * Drops are ignored while a dialog is open unless `ignoreWhenDialog` is false.
 */
export function useVideoDrop(onPaths: (paths: string[]) => void, onPick: () => void, ignoreWhenDialog = true): boolean {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const cbs = useRef({ onPaths, onPick, t, ignoreWhenDialog });
  cbs.current = { onPaths, onPick, t, ignoreWhenDialog };

  useEffect(() => {
    const toast = useApp.getState().toast;
    const dialogOpen = () => cbs.current.ignoreWhenDialog && !!document.querySelector("[data-dialog]");
    const handle = (r: DropResult) => {
      const { onPaths: go, onPick: pick, t: tr } = cbs.current;
      if (r.kind === "paths") {
        if (r.skipped > 0) toast("info", tr("library.skippedN", { n: r.skipped }));
        go(r.paths);
      } else if (r.kind === "notVideo") toast("error", tr("library.notVideo", { name: r.name }));
      else if (r.kind === "needDialog" && !inShell()) {
        // In the desktop shell the paths arrive separately through onShellDrop.
        toast("info", tr("library.dropFallback"));
        pick();
      }
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || dialogOpen()) return;
      depth.current++;
      setDragging(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!dialogOpen()) handle(readDrop(e));
    };
    const offShell = onShellDrop((r) => {
      setDragging(false);
      depth.current = 0;
      if (!dialogOpen()) handle(r);
    });
    window.addEventListener("dragover", over);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      offShell();
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return dragging;
}
