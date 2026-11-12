import { useRef, useState } from "react";
import { api } from "../api";
import type { PresetId, Project } from "../api";
import { useT, errWith } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Progress } from "../ui/States";
import { PresetList } from "./PresetList";
import { ensureModels } from "../lib/models";
import { navigate, paths } from "../lib/router";

export function RescanDialog({ project, onClose, onStarted }: { project: Project; onClose: () => void; onStarted: () => void }) {
  const t = useT();
  const system = useApp((s) => s.system);
  const toast = useApp((s) => s.toast);
  const [preset, setPreset] = useState<PresetId>(project.preset);
  const [busy, setBusy] = useState<null | number>(null);
  const downloading = useRef(false);

  const presets = (system?.presets ?? []).filter((p) => p.content === (project.content ?? "live"));
  const n = project.sources.length;

  async function start() {
    const p = presets.find((x) => x.id === preset);
    if (!p) return;
    setBusy(0);
    try {
      downloading.current = !p.installed;
      await ensureModels(p, setBusy);
    } catch (e) {
      setBusy(null);
      toast("error", errWith(t("new.downloadErr"), e));
      return;
    }
    try {
      await api.rescan(project.id, preset);
      navigate(paths.project(project.id), true);
      onStarted();
    } catch (e) {
      setBusy(null);
      toast("error", errWith(t("rescan.err"), e));
    }
  }

  return (
    <Dialog
      title={t("rescan.title")}
      onClose={onClose}
      width={600}
      dismissable={busy === null}
      footer={
        <>
          <Button onClick={onClose} disabled={busy !== null}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={start} disabled={busy !== null || !system}>
            {t("rescan.start")}
          </Button>
        </>
      }
    >
      <p className="text-fg-2 mb-4 leading-relaxed">{n > 1 ? t("rescan.bodyMulti", { n }) : t("rescan.body")}</p>
      {system && <PresetList presets={presets} value={preset} onChange={setPreset} duration={project.duration} disabled={busy !== null} />}
      {busy !== null && downloading.current && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="mono text-meta text-fg-2">{t("new.downloading", { pct: Math.round(busy * 100) })}</div>
          <Progress value={busy} />
        </div>
      )}
    </Dialog>
  );
}
