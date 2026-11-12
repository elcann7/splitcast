import type { Preset, PresetId } from "../api";
import { useT } from "../i18n";
import { fmtEstimate } from "../lib/models";

interface Props {
  presets: Preset[];
  value: PresetId;
  onChange: (id: PresetId) => void;
  /** film length in seconds, for the time estimate */
  duration: number;
  disabled?: boolean;
}

/** The quality preset as three selectable rows. */
export function PresetList({ presets, value, onChange, duration, disabled }: Props) {
  const t = useT();
  return (
    <div role="radiogroup" className="flex flex-col gap-2">
      {presets.map((p) => {
        const selected = p.id === value;
        const est = duration / Math.max(0.1, p.speedFactor);
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(p.id)}
            className={`text-left rounded-lg border px-3.5 py-3 t-fast disabled:pointer-events-none ${
              selected ? "border-accent bg-accent-dim" : "border-line-strong bg-surface-2 hover:bg-surface-3"
            } ${disabled && !selected ? "opacity-50" : ""}`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`h-4 w-4 rounded-full border shrink-0 flex items-center justify-center ${
                  selected ? "border-accent" : "border-fg-3"
                }`}
              >
                {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              <span className="font-medium text-body">{t(`preset.${p.id}` as const)}</span>
              <span className="ml-auto mono text-meta text-fg-2">{fmtEstimate(est, t)}</span>
            </div>
            <div className="pl-7 mt-1 text-meta text-fg-2 leading-snug">{t(`preset.${p.id}.desc` as const)}</div>
            <div className="pl-7 mt-1.5 flex items-center gap-3">
              <span className="mono text-meta text-fg-3 truncate">
                {p.shotDetector} · {p.faceDetector} · {p.faceRecognizer}
              </span>
              {!p.installed && p.downloadMb > 0 && (
                <span className="ml-auto mono text-meta text-fg-2 shrink-0">{t("preset.download", { mb: Math.round(p.downloadMb) })}</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
