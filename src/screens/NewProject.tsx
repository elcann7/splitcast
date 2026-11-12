import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../api";
import type { ContentKind, MediaInfo, PresetId } from "../api";
import { useT, errText, errWith } from "../i18n";
import { useApp } from "../store/app";
import { Button, IconButton } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input, Segmented } from "../ui/Fields";
import { Progress, Spinner } from "../ui/States";
import { PresetList } from "./PresetList";
import { ensureModels } from "../lib/models";
import { fmtClock } from "../lib/time";
import { fileNameOf, naturalCompare, stripExt } from "../lib/sources";
import { navigate, paths as routes } from "../lib/router";

export function mediaFacts(m: MediaInfo): string {
  const fps = +m.fps.toFixed(3);
  return `${m.width}×${m.height} · ${fps} fps · ${fmtClock(m.duration)} · ${m.videoCodec}`;
}

function guessTitle(fileName: string) {
  return stripExt(fileName)
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const folderOf = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
};

/** One file: its name. Several: their common prefix without the episode marker, else the folder name. */
function suggestTitle(ps: string[]): string {
  if (ps.length === 0) return "";
  const names = ps.map((p) => stripExt(fileNameOf(p)));
  if (names.length === 1) return guessTitle(fileNameOf(ps[0]));
  let pre = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < pre.length && i < n.length && pre[i].toLowerCase() === n[i].toLowerCase()) i++;
    pre = pre.slice(0, i);
  }
  // drop a half-written episode marker: "Show.S01E0" -> "Show", "Show Part " -> "Show"
  const cleaned = pre
    .replace(/\d+$/, "")
    .replace(/(?:^|[\s._-])(?:s\d+)?(?:episode|part|ep|e|bölüm|hissə)$/i, "")
    .replace(/[\s._-]+$/, "");
  const guess = guessTitle(cleaned);
  return guess.length >= 3 ? guess : folderOf(ps[0]) || guessTitle(names[0]);
}

type Probe = { state: "loading" } | { state: "ok"; media: MediaInfo } | { state: "err"; message: string };

export function NewProjectDialog({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const t = useT();
  const system = useApp((s) => s.system);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);

  const ordered = useMemo(
    () => [...new Set(paths)].sort((a, b) => naturalCompare(fileNameOf(a), fileNameOf(b))),
    [paths],
  );
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId>(settings?.defaultPreset ?? "balanced");
  const [content, setContent] = useState<ContentKind>("live");
  const [busy, setBusy] = useState<null | { pct: number; downloading: boolean }>(null);
  const alive = useRef(true);
  const seen = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);

  const pump = useCallback(() => {
    while (active.current < 4 && queue.current.length) {
      const path = queue.current.shift()!;
      active.current++;
      api
        .probe(path)
        .then((media): Probe => ({ state: "ok", media }))
        .catch((e): Probe => ({ state: "err", message: errText(e) }))
        .then((res) => {
          active.current--;
          if (alive.current) setProbes((p) => ({ ...p, [path]: res }));
          pump();
        });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const fresh = ordered.filter((p) => !seen.current.has(p));
    if (!fresh.length) return;
    fresh.forEach((p) => seen.current.add(p));
    setProbes((p) => ({ ...p, ...Object.fromEntries(fresh.map((x) => [x, { state: "loading" } as Probe])) }));
    queue.current.push(...fresh);
    pump();
  }, [ordered, pump]);

  const title = titleEdit ?? suggestTitle(ordered);
  const rows = ordered.map((p) => ({ path: p, probe: probes[p] ?? ({ state: "loading" } as Probe) }));
  const okRows = rows.filter((r): r is { path: string; probe: { state: "ok"; media: MediaInfo } } => r.probe.state === "ok");
  const loading = rows.some((r) => r.probe.state === "loading");
  const failed = rows.filter((r) => r.probe.state === "err").length;
  const totalDur = okRows.reduce((s, r) => s + r.probe.media.duration, 0);

  const go = (list: string[]) => {
    if (list.length === 0) onClose();
    else navigate(routes.newProject(list), true);
  };

  const presets = (system?.presets ?? []).filter((p) => p.content === content);

  async function addMore() {
    try {
      const r = await api.openVideoDialog();
      if (r.paths.length) go([...ordered, ...r.paths]);
    } catch (e) {
      toast("error", errWith(t("new.createErr"), e));
    }
  }

  async function start() {
    if (!okRows.length || !system) return;
    const p = presets.find((x) => x.id === preset);
    if (!p) return;
    setBusy({ pct: 0, downloading: !p.installed });
    try {
      await ensureModels(p, (pct) => alive.current && setBusy({ pct, downloading: true }));
    } catch (e) {
      if (alive.current) {
        setBusy(null);
        toast("error", errWith(t("new.downloadErr"), e));
      }
      return;
    }
    try {
      const r = await api.createProject({ paths: okRows.map((x) => x.path), title: title.trim() || undefined, preset, content });
      navigate(routes.project(r.projectId));
    } catch (e) {
      if (alive.current) {
        setBusy(null);
        toast("error", errWith(t("new.createErr"), e));
      }
    }
  }

  const selected = presets.find((p) => p.id === preset);
  const needsDownload = !!selected && !selected.installed;
  const running = busy !== null;

  return (
    <Dialog
      title={t("new.title")}
      onClose={onClose}
      width={680}
      dismissable={!running}
      footer={
        <>
          <Button onClick={onClose} disabled={running}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={start} disabled={!okRows.length || loading || !system || running || !title.trim()}>
            {t("new.start")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label={t("new.files")}>
          <div className="flex flex-col gap-2">
            <div className="rounded-lg border border-line-strong bg-surface-2 divide-y divide-line max-h-[228px] overflow-y-auto">
              {rows.map((r, i) => (
                <div key={r.path} className="flex items-center gap-3 min-h-9 pl-3 pr-1 py-1" title={r.path}>
                  {ordered.length > 1 && <span className="mono text-meta text-fg-3 w-5 text-right shrink-0">{i + 1}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="text-body truncate">{stripExt(fileNameOf(r.path))}</div>
                    {r.probe.state === "err" && <div className="text-meta text-fg-3 truncate">{r.probe.message}</div>}
                  </div>
                  {r.probe.state === "loading" && (
                    <span className="flex items-center gap-2 mono text-meta text-fg-3 shrink-0">
                      <Spinner size={12} />
                      {t("new.fileReading")}
                    </span>
                  )}
                  {r.probe.state === "ok" && <span className="mono text-meta text-fg-2 whitespace-nowrap shrink-0">{mediaFacts(r.probe.media)}</span>}
                  {r.probe.state === "err" && <span className="text-meta text-danger shrink-0">{t("new.fileFailed")}</span>}
                  <IconButton size="sm" disabled={running} aria-label={t("new.remove")} title={t("new.remove")} onClick={() => go(ordered.filter((x) => x !== r.path))}>
                    <X size={14} strokeWidth={1.5} />
                  </IconButton>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 min-h-7">
              <Button size="sm" variant="ghost" disabled={running} icon={<Plus size={14} strokeWidth={1.5} />} onClick={addMore}>
                {t("new.addMore")}
              </Button>
              <div className="ml-auto mono text-meta text-fg-2">
                {okRows.length > 0 && (ordered.length > 1 ? t("ws.videosDur", { n: okRows.length, dur: fmtClock(totalDur) }) : null)}
              </div>
            </div>
            {failed > 0 && <div className="text-meta text-fg-3">{okRows.length || loading ? t("new.fileFailedNote") : t("new.noneReadable")}</div>}
            {ordered.length > 1 && <div className="text-meta text-fg-3">{t("new.orderNote")}</div>}
          </div>
        </Field>
        <Field label={t("new.projectTitle")}>
          <Input value={title} onChange={(e) => setTitleEdit(e.target.value)} disabled={running} data-autofocus onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <Field label={t("new.content")} hint={t(`content.${content}.hint` as const)}>
          <Segmented<ContentKind>
            ariaLabel={t("new.content")}
            value={content}
            onChange={setContent}
            disabled={running}
            options={[
              { value: "live", label: t("content.live") },
              { value: "anime", label: t("content.anime") },
            ]}
          />
        </Field>
        {system && (
          <Field label={t("new.quality")}>
            <PresetList presets={presets} value={preset} onChange={setPreset} duration={totalDur} disabled={running} />
          </Field>
        )}
        {busy?.downloading ? (
          <div className="flex flex-col gap-2">
            <div className="text-meta text-fg-2 mono">{t("new.downloading", { pct: Math.round(busy.pct * 100) })}</div>
            <Progress value={busy.pct} />
          </div>
        ) : (
          needsDownload && selected && <div className="text-meta text-fg-2">{t("new.downloadNote", { mb: Math.round(selected.downloadMb) })}</div>
        )}
      </div>
    </Dialog>
  );
}
