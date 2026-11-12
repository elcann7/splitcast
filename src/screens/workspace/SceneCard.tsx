import { memo, useEffect, useRef, useState } from "react";
import { Check, Scissors } from "lucide-react";
import type { Appearance } from "../../api";
import { fmtClock, fmtLen } from "../../lib/time";

interface Props {
  a: Appearance;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  focused: boolean;
  trimmed: boolean;
  /** effective length after trims */
  length: number;
  /** URL of the proxy clip, or null when preview is unavailable */
  previewSrc: string | null;
  onClick: (a: Appearance, index: number, e: React.MouseEvent) => void;
  onContext: (a: Appearance, index: number, e: React.MouseEvent) => void;
}

const HOVER_DELAY = 380;

export const SceneCard = memo(function SceneCard({ a, index, x, y, w, h, selected, focused, trimmed, length, previewSrc, onClick, onContext }: Props) {
  const [hover, setHover] = useState(false);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const dur = a.end - a.start;
  const shadow = selected
    ? focused
      ? "0 0 0 2px #E9A23B, inset 0 0 0 1px rgba(237,237,234,.95)"
      : "0 0 0 2px #E9A23B"
    : focused
      ? "0 0 0 1px #EDEDEA"
      : undefined;

  return (
    <div className="anim-fade" style={{ position: "absolute", left: 0, top: 0, width: w, height: h, transform: `translate(${x}px, ${y}px)` }}>
      <button
        type="button"
        data-scene={a.id}
        onClick={(e) => onClick(a, index, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(a, index, e);
        }}
        onMouseEnter={() => {
          if (!previewSrc) return;
          timer.current = setTimeout(() => setHover(true), HOVER_DELAY);
        }}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          setHover(false);
          setPlaying(false);
        }}
        style={{ boxShadow: shadow }}
        className={`group relative block w-full h-full rounded-lg overflow-hidden bg-surface-2 border t-fast active:scale-[0.985] ${
          selected ? "border-accent" : "border-line hover:border-line-strong"
        }`}
      >
        <img
          src={a.thumb}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={(e) => (e.currentTarget.dataset.loaded = "1")}
          className="img-fade absolute inset-0 w-full h-full object-cover group-hover:scale-[1.045]"
        />
        {hover && previewSrc && (
          <video
            ref={video}
            src={previewSrc}
            muted
            playsInline
            preload="auto"
            autoPlay
            className={`absolute inset-0 w-full h-full object-cover bg-black t-fast ${playing ? "opacity-100" : "opacity-0"}`}
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = a.previewOffset;
            }}
            onPlaying={() => setPlaying(true)}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              if (v.currentTime >= a.previewOffset + dur - 0.05) v.currentTime = a.previewOffset;
            }}
            onError={() => setHover(false)}
          />
        )}
        <span className="absolute left-1.5 bottom-1.5 mono text-[11px] leading-4 px-1.5 rounded bg-black/65 text-fg-1">{fmtClock(a.start)}</span>
        <span className="absolute right-1.5 bottom-1.5 mono text-[11px] leading-4 px-1.5 rounded bg-black/65 text-fg-1">{fmtLen(length)}</span>
        {selected && (
          <span className="anim-check absolute left-1.5 top-1.5 h-[18px] w-[18px] rounded bg-accent text-accent-on flex items-center justify-center">
            <Check size={12} strokeWidth={3} />
          </span>
        )}
        {trimmed && (
          <span className="absolute right-1.5 top-1.5 h-[18px] w-[18px] rounded bg-black/65 text-fg-1 flex items-center justify-center" title="trim">
            <Scissors size={11} strokeWidth={1.75} />
          </span>
        )}
      </button>
    </div>
  );
});
