import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import type { Preset, Settings, StorageInfo } from "../api";
import { useT, errWith, LANGS } from "../i18n";
import type { Lang } from "../i18n";
import { useApp } from "../store/app";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Fields";
import { ErrorState, LoadingBlock, Progress } from "../ui/States";
import { ExportOptions } from "./ExportOptions";
import { ensureModels } from "../lib/models";
import { ENCODER_NAME } from "../lib/encoder";
import { fmtBytes } from "../lib/time";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="text-section font-semibold mb-3">{title}</h2>
      <div className="rounded-lg border border-line bg-surface-1 divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 min-h-[52px] py-2.5">
      <div className="min-w-0">
        <div className="text-body">{label}</div>
        {hint && <div className="text-meta text-fg-3 mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2 text-right">{children}</div>
    </div>
  );
}

export function SettingsScreen() {
  const t = useT();
  const settings = useApp((s) => s.settings);
  const system = useApp((s) => s.system);
  const save = useApp((s) => s.saveSettings);
  const toast = useApp((s) => s.toast);

  const persist = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        await save(patch);
      } catch (e) {
        toast("error", errWith(t("settings.saveErr"), e));
      }
    },
    [save, toast, t],
  );

  if (!settings || !system) return <LoadingBlock />;
  const dev = system.device;

  return (
    <div className="h-full flex flex-col">
      <header className="h-16 shrink-0 flex items-center px-8 border-b border-line">
        <h1 className="text-page font-semibold">{t("settings.title")}</h1>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-8 grid gap-x-8 gap-y-8 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(460px, 1fr))" }}>
          <div className="flex flex-col gap-8 min-w-0">
            <Section title={t("settings.language")}>
              <Row label={t("settings.interfaceLang")}>
                <Select
                  className="min-w-[180px]"
                  value={settings.language}
                  onChange={(e) => persist({ language: e.target.value as Lang })}
                >
                  {LANGS.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Row>
            </Section>

            <Section title={t("settings.device")}>
              <Row label={t("settings.gpu")}>
                <span className="mono text-meta text-fg-1">
                  {dev.gpuName ?? t("settings.noGpu")}
                  {dev.vramMb ? ` · ${(dev.vramMb / 1024).toFixed(0)} GB` : ""}
                </span>
              </Row>
              <Row label={t("settings.compute")} hint={dev.note ?? undefined}>
                <span className="mono text-meta text-fg-1">{dev.provider === "cuda" ? t("settings.cuda") : dev.provider === "dml" ? "DirectML (GPU)" : t("settings.cpu")}</span>
              </Row>
              <Row label={t("settings.ffmpeg")}>
                <span className="mono text-meta text-fg-1">{system.ffmpeg.ok ? (system.ffmpeg.version ?? "ok") : t("settings.ffmpegMissing")}</span>
              </Row>
              <Row label={t("settings.nvenc")}>
                <span className="mono text-meta text-fg-1">{system.ffmpeg.encoder ? ENCODER_NAME[system.ffmpeg.encoder] : t("settings.no")}</span>
              </Row>
            </Section>

            <Section title={t("settings.models")}>
              {system.presets.map((p) => (
                <ModelRow key={p.content + p.id} preset={p} />
              ))}
            </Section>

            <Section title={t("settings.storage")}>
              <StorageRows />
              <Row label={t("settings.about")}>
                <span className="mono text-meta text-fg-2">{system.version}</span>
              </Row>
            </Section>
          </div>

          <div className="flex flex-col gap-8 min-w-0">
            <Section title={t("settings.defaults")}>
              <Row label={t("settings.defaultPreset")}>
                <Select
                  value={settings.defaultPreset}
                  onChange={(e) => persist({ defaultPreset: e.target.value as Settings["defaultPreset"] })}
                  wrapClass="w-44"
                >
                  {system.presets.filter((p) => p.content === "live").map((p) => (
                    <option key={p.id} value={p.id}>
                      {t(`preset.${p.id}` as const)}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label={t("settings.exportDir")}>
                <Input
                  readOnly
                  value={settings.exportDir}
                  title={settings.exportDir}
                  className="mono text-meta w-80 text-ellipsis"
                />
                <Button
                  onClick={async () => {
                    try {
                      const r = await api.chooseFolder();
                      if (r.path) persist({ exportDir: r.path });
                    } catch (e) {
                      toast("error", errWith(t("settings.saveErr"), e));
                    }
                  }}
                >
                  {t("common.browse")}
                </Button>
              </Row>
              <div className="px-4 py-4">
                <div className="text-body font-medium mb-4">{t("settings.exportDefaults")}</div>
                <ExportOptions value={settings.export} onChange={(ex) => persist({ export: ex })} />
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelRow({ preset }: { preset: Preset }) {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [pct, setPct] = useState<number | null>(null);

  async function download() {
    setPct(0);
    try {
      await ensureModels(preset, setPct);
    } catch (e) {
      toast("error", errWith(t("new.downloadErr"), e));
    }
    setPct(null);
  }

  return (
    <Row
      label={t(`preset.${preset.id}` as const)}
      hint={<span className="mono">{preset.faceDetector} · {preset.faceRecognizer}</span>}
    >
      {preset.installed ? (
        <span className="inline-flex items-center gap-1.5 text-meta text-fg-2">
          <Check size={14} strokeWidth={2} className="text-ok" />
          {t("preset.installed")}
        </span>
      ) : pct !== null ? (
        <div className="w-40 flex flex-col gap-1.5">
          <span className="mono text-meta text-fg-2">{t("settings.downloading", { pct: Math.round(pct * 100) })}</span>
          <Progress value={pct} />
        </div>
      ) : (
        <Button onClick={download}>{t("settings.download", { mb: Math.round(preset.downloadMb) })}</Button>
      )}
    </Row>
  );
}

function StorageRows() {
  const t = useT();
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);

  const load = useCallback(() => {
    api
      .storage()
      .then((s) => {
        setInfo(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  if (failed) {
    return (
      <div className="h-40">
        <ErrorState title={t("settings.storageErr")} onRetry={load} />
      </div>
    );
  }
  const val = (n?: number) => <span className="mono text-meta text-fg-1">{n === undefined ? "—" : fmtBytes(n)}</span>;
  return (
    <>
      <Row label={t("settings.projects")}>{val(info?.projectsBytes)}</Row>
      <Row label={t("settings.modelsSize")}>{val(info?.modelsBytes)}</Row>
      <Row label={t("settings.previews")} hint={freed !== null ? t("settings.cleared", { size: fmtBytes(freed) }) : undefined}>
        {val(info?.previewsBytes)}
        <Button
          disabled={clearing || !info || info.previewsBytes === 0}
          onClick={async () => {
            setClearing(true);
            try {
              const r = await api.clearPreviews();
              setFreed(r.freedBytes);
              load();
            } catch (e) {
              toast("error", errWith(t("settings.clearErr"), e));
            }
            setClearing(false);
          }}
        >
          {t("settings.clearPreviews")}
        </Button>
      </Row>
    </>
  );
}
