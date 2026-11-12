import { useMemo, useRef, useState } from "react";
import type { Appearance, Source } from "../../api";
import { useT } from "../../i18n";
import { fmtClock } from "../../lib/time";

interface Props {
  all: Appearance[];
  /** the project's videos in order; they are laid end to end, proportionally to their length */
  sources: Source[];
  visibleIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  focusId: string | null;
  onPick: (a: Appearance, visible: boolean) => void;
}

/**
 * One thin bar the length of the whole project with a tick for every appearance of the
 * current character. Clicking picks the nearest tick.
 */
export function AppearanceTrack({ all, sources, visibleIds, selected, focusId, onPick }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; a: Appearance } | null>(null);

  const { offset, total } = useMemo(() => {
    const offset = new Map<string, number>();
    let acc = 0;
    for (const s of sources) {
      offset.set(s.id, acc);
      acc += s.media.duration;
    }
    return { offset, total: Math.max(acc, 1e-6) };
  }, [sources]);

  /** appearances with their position on the whole-project axis, in order */
  const ticks = useMemo(
    () =>
      all
        .map((a) => ({ a, at: (offset.get(a.sourceId) ?? 0) + (a.start + a.end) / 2 }))
        .sort((x, y) => x.at - y.at),
    [all, offset],
  );
  const labelOf = (sid: string) => sources.find((s) => s.id === sid)?.label ?? "";

  const nearest = (clientX: number) => {
    const el = box.current;
    if (!el || !ticks.length) return null;
    const r = el.getBoundingClientRect();
    const px = clientX - r.left;
    const tm = (px / r.width) * total;
    let lo = 0;
    let hi = ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid].at < tm) lo = mid + 1;
      else hi = mid;
    }
    let best: (typeof ticks)[number] | null = null;
    let bestD = Infinity;
    for (const c of [ticks[lo - 1], ticks[lo]]) {
      if (!c) continue;
      const d = Math.abs((c.at / total) * r.width - px);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best && bestD <= 9 ? { a: best.a, x: (best.at / total) * r.width } : null;
  };

  const focused = focusId ? ticks.find((x) => x.a.id === focusId) : null;
  const multi = sources.length > 1;

  return (
    <div dir="ltr" className="shrink-0 border-t border-line px-4 pt-2.5 pb-2 bg-surface-1" aria-label={t("scenes.track")}>
      <div
        ref={box}
        className="relative h-6 cursor-pointer"
        onMouseMove={(e) => setHover(nearest(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const n = nearest(e.clientX);
          if (n) onPick(n.a, visibleIds.has(n.a.id));
        }}
      >
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 rounded-full bg-surface-3" />
        {multi &&
          sources.slice(1).map((s) => (
            <span key={s.id} className="absolute top-0.5 bottom-0.5 w-px bg-line-strong" style={{ left: `${((offset.get(s.id) ?? 0) / total) * 100}%` }} />
          ))}
        {ticks.map(({ a, at }) => {
          const vis = visibleIds.has(a.id);
          const sel = selected.has(a.id);
          return (
            <span
              key={a.id}
              className={`t-track absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-px ${sel ? "bg-accent h-4 w-[2px]" : vis ? "bg-fg-2 h-3" : "bg-fg-3/40 h-2"}`}
              style={{ left: `${(at / total) * 100}%` }}
            />
          );
        })}
        {focused && (
          <span
            className="t-track absolute top-0 bottom-0 -translate-x-1/2 w-[2px] bg-fg-1 rounded-full pointer-events-none"
            style={{ left: `${(focused.at / total) * 100}%` }}
          />
        )}
        {hover && (
          <div
            className="absolute bottom-full mb-1.5 -translate-x-1/2 pointer-events-none rounded bg-surface-3 border border-line-strong px-1.5 py-0.5 mono text-[11px] text-fg-1 whitespace-nowrap shadow-float"
            style={{ left: Math.max(30, hover.x) }}
          >
            {multi ? `${labelOf(hover.a.sourceId)} · ` : ""}
            {fmtClock(hover.a.start)}
          </div>
        )}
      </div>
      {multi ? (
        <div className="relative h-4 mt-0.5 select-none">
          {sources.map((s) => (
            <span
              key={s.id}
              title={`${s.label} · ${fmtClock(s.media.duration)}`}
              className="absolute top-0 text-[11px] text-fg-3 truncate pl-1 pr-1"
              style={{ left: `${((offset.get(s.id) ?? 0) / total) * 100}%`, width: `${(s.media.duration / total) * 100}%` }}
            >
              {s.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex justify-between mono text-[11px] text-fg-3 mt-0.5 select-none">
          <span>0:00</span>
          <span>{fmtClock(total)}</span>
        </div>
      )}
    </div>
  );
}
