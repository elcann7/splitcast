import type { ExportCodec, ExportOptionsT } from "../api";
import { useT } from "../i18n";
import { Checkbox, Field, Input, Segmented } from "../ui/Fields";

const CODECS: ExportCodec[] = ["copy", "h264", "hevc", "prores"];

interface Props {
  value: ExportOptionsT;
  onChange: (v: ExportOptionsT) => void;
  disabled?: boolean;
}

/** Mode, codec, quality, audio, padding, join. Used by the export dialog and by Settings. */
export function ExportOptions({ value, onChange, disabled }: Props) {
  const t = useT();
  const set = (patch: Partial<ExportOptionsT>) => onChange({ ...value, ...patch });
  const hasQuality = value.codec === "h264" || value.codec === "hevc";

  return (
    <div className={`flex flex-col gap-5 ${disabled ? "opacity-60 pointer-events-none" : ""}`}>
      <Field label={t("export.mode")}>
        <div>
          <Segmented
            value={value.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { value: "clips", label: t("export.mode.clips") },
              { value: "merged", label: t("export.mode.merged") },
            ]}
          />
        </div>
      </Field>

      <Field label={t("export.codec")}>
        <div role="radiogroup" className="grid grid-cols-2 gap-2">
          {CODECS.map((c) => {
            const sel = value.codec === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => set({ codec: c })}
                className={`text-left rounded-lg border px-3 py-2.5 t-fast ${
                  sel ? "border-accent bg-accent-dim" : "border-line-strong bg-surface-2 hover:bg-surface-3"
                }`}
              >
                <div className="text-body font-medium">{t(`export.codec.${c}` as const)}</div>
                <div className="text-meta text-fg-2 mt-0.5 leading-snug">{t(`export.codec.${c}.desc` as const)}</div>
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-x-5 gap-y-5">
        <Field label={t("export.quality")} hint={hasQuality ? t("export.quality.hint") : t("export.quality.na")}>
          <div>
            <Segmented
              value={value.quality}
              onChange={(quality) => set({ quality })}
              disabled={!hasQuality}
              options={[
                { value: "high", label: t("export.quality.high") },
                { value: "master", label: t("export.quality.master") },
              ]}
            />
          </div>
        </Field>
        <Field label={t("export.padding")} hint={t("export.paddingHint")}>
          <div className="relative w-32">
            <Input
              type="number"
              min={0}
              max={5000}
              step={50}
              value={value.paddingMs}
              onChange={(e) => set({ paddingMs: Math.max(0, Math.min(5000, Math.round(Number(e.target.value) || 0))) })}
              className="mono pr-9 text-right"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 mono text-meta text-fg-3 pointer-events-none">ms</span>
          </div>
        </Field>
        <Checkbox checked={value.audio} onChange={(audio) => set({ audio })} label={t("export.audio")} />
        <Checkbox checked={value.joinAdjacent} onChange={(joinAdjacent) => set({ joinAdjacent })} label={t("export.join")} hint={t("export.joinHint")} />
      </div>
    </div>
  );
}
