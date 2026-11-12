import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { api } from "../../api";
import type { Appearance } from "../../api";
import { useT } from "../../i18n";
import { Button, IconButton } from "../../ui/Button";
import { Spinner } from "../../ui/States";
import { clamp, fmtTc, snapFrame } from "../../lib/time";
import { useWorkspace } from "./ctx";

const MIN_LEN = 0.2;
const HANDLE_LEAD = 2; // fallback: assume 2 s of handle after the scene while metadata is loading

type LoadState = "idle" | "loading" | "ready" | "error";

export function Inspector() {
  const t = useT();
  const w = useWorkspace();
  const { project, char, focusId, selected, trims, setTrim, setSelection } = w;

  const focus = useMemo(() => (char && focusId ? (char.appearances.find((a) => a.id === focusId) ?? null) : null), [char, focusId]);
  const focusSrc = focus ? (project.sources.find((s) => s.id === focus.sourceId) ?? null) : null;
  const fps = focusSrc?.media.fps || 24;

  // the player follows focus with a short delay so arrow-key browsing does not build a preview for every scene
  const [a, setA] = useState<Appearance | null>(focus);
  useEffect(() => {
    if (!focus) return setA(null);
    if (a && focus.id === a.id) return setA(focus);
    const id = setTimeout(() => setA(focus), a ? 220 : 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const shown = a && focus && a.id === focus.id ? a : null;

  return (
    <aside className="w-[360px] shrink-0 flex flex-col bg-surface-1 border-l border-line min-h-0">
      <div className="h-11 shrink-0 flex items-center justify-between px-4 border-b border-line">
        <h2 className="text-section font-semibold">{t("insp.title")}</h2>
        {focus && (
          <span className="mono text-meta text-fg-3 truncate min-w-0 pl-3" title={focusSrc?.label}>
            {project.sources.length > 1 && focusSrc ? `${focusSrc.label} · ` : ""}
            {t("insp.scene", { n: focus.shotIndex })}
          </span>
        )}
      </div>
      {!focus ? (
        <div className="flex-1 flex items-center justify-center px-8 text-center text-fg-2 leading-relaxed">{t("insp.empty")}</div>
      ) : (
        <Player
          key={focus.id}
          focus={focus}
          ready={!!shown}
          fps={fps}
          sourceMissing={!!focusSrc?.sourceMissing}
          projectId={project.id}
          trim={trims[focus.id] ?? null}
          setTrim={(tr) => setTrim(focus.id, tr)}
          registerHandle={(h) => (w.inspector.current = h)}
          isSelected={selected.has(focus.id)}
          toggleSelected={() => {
            const next = new Set(selected);
            if (next.has(focus.id)) next.delete(focus.id);
            else next.add(focus.id);
            setSelection(next);
          }}
          onMove={() => w.openMove([focus.id])}
        />
      )}
    </aside>
  );
}

interface PlayerProps {
  focus: Appearance;
  ready: boolean;
  fps: number;
  sourceMissing: boolean;
  projectId: string;
  trim: { start: number; end: number } | null;
  setTrim: (t: { start: number; end: number } | null) => void;
  registerHandle: (h: { toggle: () => void; markIn: () => void; markOut: () => void } | null) => void;
  isSelected: boolean;
  toggleSelected: () => void;
  onMove: () => void;
}

function Player({ focus: a, ready, fps, sourceMissing, projectId, trim, setTrim, registerHandle, isSelected, toggleSelected, onMove }: PlayerProps) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [vdur, setVdur] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cur, setCur] = useState(trim?.start ?? a.start); // absolute source time of the playhead
  const [drag, setDrag] = useState<{ which: "in" | "out"; v: number } | null>(null);

  const previewStart = a.start - a.previewOffset;
  const expected = a.previewOffset + (a.end - a.start) + HANDLE_LEAD;
  const clipLen = vdur ? Math.min(vdur, expected) : expected; // the proxy clip is the scene plus handles; never longer
  const previewEnd = previewStart + clipLen;
  const saved = trim ?? { start: a.start, end: a.end };
  const inT = drag?.which === "in" ? drag.v : saved.start;
  const outT = drag?.which === "out" ? drag.v : saved.end;
  const src = ready && !sourceMissing ? api.previewUrl(projectId, a.id) : null;

  const refs = useRef({ inT, outT, cur, previewStart, playing });
  refs.current = { inT, outT, cur, previewStart, playing };

  const seekAbs = useCallback((abs: number) => {
    const v = video.current;
    const p = refs.current.previewStart;
    if (v && v.readyState >= 1) v.currentTime = clamp(abs - p, 0, v.duration || 1e9);
    setCur(abs);
  }, []);

  // commit trims; drop the override when it equals the original
  const commit = useCallback(
    (s: number, e: number) => {
      const same = Math.abs(s - a.start) < 0.5 / fps && Math.abs(e - a.end) < 0.5 / fps;
      setTrim(same ? null : { start: s, end: e });
    },
    [a.start, a.end, fps, setTrim],
  );

  const play = useCallback(() => {
    const v = video.current;
    if (!v || state !== "ready") return;
    const { inT: i, outT: o, cur: c } = refs.current;
    if (c < i - 0.01 || c >= o - 0.03) seekAbs(i);
    v.play().catch(() => {});
  }, [state, seekAbs]);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v || state !== "ready") return;
    if (v.paused) play();
    else v.pause();
  }, [state, play]);

  const markIn = useCallback(() => {
    const { cur: c, outT: o } = refs.current;
    const s = snapFrame(clamp(c, previewStart, o - MIN_LEN), fps);
    commit(s, o);
  }, [commit, previewStart, fps]);
  const markOut = useCallback(() => {
    const { cur: c, inT: i } = refs.current;
    const e = snapFrame(clamp(c, i + MIN_LEN, previewStart + clipLen), fps);
    commit(i, e);
  }, [commit, previewStart, clipLen, fps]);

  useEffect(() => {
    registerHandle({ toggle, markIn, markOut });
    return () => registerHandle(null);
  }, [registerHandle, toggle, markIn, markOut]);

  // playhead follows the video; playback stops at the out point
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      const v = video.current;
      if (v) {
        const abs = v.currentTime + refs.current.previewStart;
        setCur(abs);
        if (abs >= refs.current.outT - 0.02) {
          v.pause();
          setCur(refs.current.outT);
          return;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // ---- timeline pointer handling
  const toAbs = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return previewStart + clamp((clientX - r.left) / r.width, 0, 1) * clipLen;
  };
  const pct = (abs: number) => `${clamp((abs - previewStart) / clipLen, 0, 1) * 100}%`;

  const startScrub = (e: React.PointerEvent) => {
    if (state !== "ready") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    video.current?.pause();
    seekAbs(toAbs(e.clientX));
    const move = (ev: PointerEvent) => seekAbs(toAbs(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startHandle = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    video.current?.pause();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const calc = (x: number) => {
      const abs = snapFrame(toAbs(x), fps);
      return which === "in"
        ? clamp(abs, previewStart, refs.current.outT - MIN_LEN)
        : clamp(abs, refs.current.inT + MIN_LEN, previewEnd);
    };
    let last = calc(e.clientX);
    setDrag({ which, v: last });
    seekAbs(last);
    const move = (ev: PointerEvent) => {
      last = calc(ev.clientX);
      setDrag({ which, v: last });
      seekAbs(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (which === "in") commit(last, refs.current.outT);
      else commit(refs.current.inT, last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHandleKey = (which: "in" | "out") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1) / fps;
    if (which === "in") commit(snapFrame(clamp(inT + d, previewStart, outT - MIN_LEN), fps), outT);
    else commit(inT, snapFrame(clamp(outT + d, inT + MIN_LEN, previewEnd), fps));
  };

  const trimmed = !!trim;
  const len = outT - inT;
  const fact = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-3 h-7">
      <dt className="text-fg-2">{label}</dt>
      <dd className="mono text-meta text-fg-1">{value}</dd>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-4 flex flex-col gap-4">
        {/* player */}
        <div className="relative aspect-video rounded-lg overflow-hidden bg-black border border-line">
          <img src={a.thumb} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
          {src && (
            <video
              ref={video}
              src={src}
              preload="auto"
              playsInline
              muted={muted}
              className={`absolute inset-0 w-full h-full object-contain bg-black ${state === "ready" ? "opacity-100" : "opacity-0"}`}
              onLoadStart={() => setState("loading")}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setVdur(isFinite(v.duration) ? v.duration : null);
                v.currentTime = clamp(saved.start - previewStart, 0, v.duration || 1e9);
              }}
              onCanPlay={() => setState("ready")}
              onError={() => setState("error")}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onSeeked={(e) => !refs.current.playing && setCur(e.currentTarget.currentTime + refs.current.previewStart)}
            />
          )}
          {sourceMissing && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center px-6 text-center text-meta text-fg-1 leading-snug">{t("insp.noSource")}</div>
          )}
          {!sourceMissing && (state === "loading" || !ready) && (
            <div className="absolute inset-0 bg-black/55 flex items-center justify-center gap-2 text-meta text-fg-1">
              <Spinner size={14} />
              {t("insp.loading")}
            </div>
          )}
          {state === "error" && (
            <div className="absolute inset-0 bg-black/75 flex items-center justify-center px-6 text-center text-meta text-fg-1 leading-snug">{t("insp.error")}</div>
          )}
        </div>

        {/* transport */}
        <div className="flex items-center gap-2">
          <IconButton onClick={toggle} disabled={state !== "ready"} aria-label={playing ? t("insp.pause") : t("insp.play")} title={`${playing ? t("insp.pause") : t("insp.play")} (Space)`} className="!bg-surface-3 !text-fg-1">
            {playing ? <Pause size={16} strokeWidth={1.5} /> : <Play size={16} strokeWidth={1.5} />}
          </IconButton>
          <span className="mono text-body text-fg-1 tabular-nums">{fmtTc(cur, fps)}</span>
          <div className="flex-1" />
          <Button size="sm" onClick={markIn} disabled={state !== "ready"} title={t("insp.trimIn")}>
            <span className="mono">I</span> {t("insp.in")}
          </Button>
          <Button size="sm" onClick={markOut} disabled={state !== "ready"} title={t("insp.trimOut")}>
            <span className="mono">O</span> {t("insp.out")}
          </Button>
          <IconButton size="sm" onClick={() => setMuted((m) => !m)} aria-label={muted ? t("insp.unmute") : t("insp.mute")} title={muted ? t("insp.unmute") : t("insp.mute")}>
            {muted ? <VolumeX size={16} strokeWidth={1.5} /> : <Volume2 size={16} strokeWidth={1.5} />}
          </IconButton>
        </div>

        {/* trim timeline */}
        <div>
          <div
            ref={bar}
            onPointerDown={startScrub}
            className={`relative h-9 rounded bg-surface-2 border border-line touch-none ${state === "ready" ? "cursor-pointer" : "opacity-60"}`}
          >
            <div
              className="absolute top-0 bottom-0 bg-accent-dim border-y-2 border-accent pointer-events-none"
              style={{ left: pct(inT), width: `calc(${pct(outT)} - ${pct(inT)})` }}
            />
            {(["in", "out"] as const).map((which) => (
              <div
                key={which}
                role="slider"
                tabIndex={0}
                aria-label={which === "in" ? t("insp.trimIn") : t("insp.trimOut")}
                aria-valuemin={previewStart}
                aria-valuemax={previewEnd}
                aria-valuenow={which === "in" ? inT : outT}
                onPointerDown={startHandle(which)}
                onKeyDown={onHandleKey(which)}
                className="absolute top-[-3px] bottom-[-3px] w-2.5 -ml-[5px] cursor-ew-resize flex items-center justify-center"
                style={{ left: pct(which === "in" ? inT : outT), zIndex: 2 }}
              >
                <span className="h-full w-[6px] rounded-sm bg-fg-1 border border-surface-0" />
              </div>
            ))}
            <div className="absolute top-[-4px] bottom-[-4px] w-[2px] -ml-px bg-accent pointer-events-none rounded-full" style={{ left: pct(cur), zIndex: 3 }} />
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {[
              [t("insp.in"), inT, () => seekAbs(inT)],
              [t("insp.out"), outT, () => seekAbs(outT)],
              [t("insp.duration"), len, undefined],
            ].map(([label, v, f]) => (
              <button
                key={label as string}
                type="button"
                onClick={f as (() => void) | undefined}
                disabled={!f}
                className="text-left rounded px-2 py-1.5 bg-surface-2 border border-line enabled:hover:border-line-strong disabled:cursor-default t-fast"
              >
                <div className="text-[11px] text-fg-3 leading-3">{label as string}</div>
                <div className="mono text-meta text-fg-1 mt-1">{label === t("insp.duration") ? `${(v as number).toFixed(2)}s` : fmtTc(v as number, fps)}</div>
              </button>
            ))}
          </div>
          <div className="mt-2 -ml-2.5">
            <Button size="sm" variant="ghost" disabled={!trimmed} onClick={() => setTrim(null)}>
              {t("insp.resetTrim")}
            </Button>
          </div>
        </div>

        {/* facts */}
        <dl className="border-t border-line pt-3 text-body">
          {fact(t("insp.size"), t(`scenes.size.${a.shotSize}` as const))}
          {fact(t("insp.people"), a.solo ? t("insp.solo") : t("insp.peopleN", { n: a.peopleCount }))}
          {fact(t("insp.confidence"), `${Math.round(a.confidence * 100)}%`)}
          {fact(t("insp.coverage"), `${Math.round(a.coverage * 100)}%`)}
          {fact(t("insp.shot"), `#${a.shotIndex}`)}
        </dl>

        <div className="flex gap-2">
          <Button className="flex-1" onClick={toggleSelected}>
            {isSelected ? t("insp.unselect") : t("insp.select")}
          </Button>
          <Button onClick={onMove}>{t("scenes.moveBtn")}…</Button>
        </div>
        <div className="mono text-[11px] text-fg-3 leading-relaxed">{t("insp.keys")}</div>
      </div>
    </div>
  );
}
