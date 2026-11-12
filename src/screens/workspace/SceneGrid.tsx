import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Appearance } from "../../api";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { Trim } from "../../store/workspace";
import { SceneCard } from "./SceneCard";

/** A run of consecutive items that belong to one video; rendered under a thin header. */
export interface Section {
  key: string;
  label: string;
  /** index of the first item in `items` */
  start: number;
  count: number;
  missing: boolean;
}

interface Props {
  items: Appearance[];
  /** when given, items are grouped under these headers (their ranges must cover `items` in order) */
  sections: Section[] | null;
  selected: ReadonlySet<string>;
  focusId: string | null;
  trims: Record<string, Trim>;
  projectId: string;
  /** appearance ids whose preview cannot play (their video file is gone) */
  noPreview: ReadonlySet<string> | null;
  colsRef: { current: number };
  scrollReq: { id: string; n: number; center: boolean } | null;
  onCardClick: (a: Appearance, index: number, e: React.MouseEvent) => void;
  onCardContext: (a: Appearance, index: number, e: React.MouseEvent) => void;
  onSectionToggle: (s: Section) => void;
}

const PAD = 16;
const GAP = 10;
const MIN_W = 172;
const OVERSCAN_ROWS = 3;
const HEAD_H = 30;
const HEAD_GAP = 8;
const SECTION_GAP = 14;

/**
 * Windowed grid: only the cards near the viewport are in the DOM, so a character with
 * thousands of scenes scrolls as smoothly as one with twenty. With sections, every video
 * gets a header; the header of the video being scrolled through stays pinned at the top.
 */
export function SceneGrid({ items, sections, selected, focusId, trims, projectId, noPreview, colsRef, scrollReq, onCardClick, onCardContext, onSectionToggle }: Props) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [top, setTop] = useState(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inner = Math.max(0, size.w - PAD * 2);
  const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_W + GAP)));
  const cardW = (inner - GAP * (cols - 1)) / cols;
  const cardH = Math.round((cardW * 9) / 16);
  const rowH = cardH + GAP;
  colsRef.current = cols;

  // y of every item and header. Item ys never decrease, so the visible window is a binary search.
  const layout = useMemo(() => {
    const ys = new Float64Array(items.length);
    const heads: { y: number; s: Section }[] = [];
    let y = PAD;
    const groups = sections ?? [{ key: "", label: "", start: 0, count: items.length, missing: false }];
    for (const s of groups) {
      if (sections) {
        heads.push({ y, s });
        y += HEAD_H + HEAD_GAP;
      }
      for (let k = 0; k < s.count; k++) ys[s.start + k] = y + Math.floor(k / cols) * rowH;
      y += Math.ceil(s.count / cols) * rowH - GAP + (sections ? SECTION_GAP : 0);
    }
    return { ys, heads, total: items.length ? y + PAD - (sections ? SECTION_GAP : 0) : 0 };
  }, [items.length, sections, cols, rowH]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setTop(el.scrollTop);
  }, []);

  // scroll requests: arrow keys, the appearance track
  const lastReq = useRef(0);
  useEffect(() => {
    if (!scrollReq || scrollReq.n === lastReq.current) return;
    const el = scroller.current;
    const idx = items.findIndex((a) => a.id === scrollReq.id);
    if (!el || idx < 0 || size.h === 0) return;
    lastReq.current = scrollReq.n;
    const y = layout.ys[idx];
    const pinned = sections ? HEAD_H + 4 : 0;
    if (scrollReq.center) el.scrollTop = y - (size.h - cardH) / 2;
    else if (y - GAP - pinned < el.scrollTop) el.scrollTop = y - PAD - pinned;
    else if (y + cardH + GAP > el.scrollTop + size.h) el.scrollTop = y + cardH + PAD - size.h;
  }, [scrollReq, items, layout, cardH, size.h, sections]);

  const lower = (v: number) => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (layout.ys[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const over = OVERSCAN_ROWS * rowH;
  const from = lower(top - over - cardH);
  const to = lower(top + size.h + over);

  const sectionOf = sections
    ? (i: number) => {
        let k = 0;
        while (k + 1 < sections.length && sections[k + 1].start <= i) k++;
        return sections[k];
      }
    : null;

  const cards = [];
  for (let i = from; i < to; i++) {
    const a = items[i];
    const tr = trims[a.id];
    const col = sectionOf ? (i - sectionOf(i).start) % cols : i % cols;
    cards.push(
      <SceneCard
        key={a.id}
        a={a}
        index={i}
        x={PAD + col * (cardW + GAP)}
        y={layout.ys[i]}
        w={cardW}
        h={cardH}
        selected={selected.has(a.id)}
        focused={a.id === focusId}
        trimmed={!!tr}
        length={tr ? tr.end - tr.start : a.end - a.start}
        previewSrc={noPreview?.has(a.id) ? null : api.previewUrl(projectId, a.id)}
        onClick={onCardClick}
        onContext={onCardContext}
      />,
    );
  }

  const header = (s: Section, style: React.CSSProperties, pinned: boolean) => {
    let nSel = 0;
    for (let k = 0; k < s.count; k++) if (selected.has(items[s.start + k].id)) nSel++;
    const all = nSel === s.count;
    return (
      <button
        key={(pinned ? "pin-" : "h-") + s.key}
        type="button"
        onClick={() => onSectionToggle(s)}
        title={all ? t("scenes.sectionDeselect") : t("scenes.sectionSelect")}
        style={{ ...style, height: HEAD_H }}
        className={`absolute left-4 right-4 flex items-center gap-3 px-2.5 rounded text-left t-fast hover:bg-surface-3 ${
          pinned ? "bg-surface-2 border border-line-strong shadow-float z-10" : "bg-surface-1 border border-line"
        }`}
      >
        <span className="text-body font-medium truncate min-w-0">{s.label}</span>
        <span className="mono text-meta text-fg-3 shrink-0">{t("scenes.sectionCount", { n: s.count })}</span>
        {s.missing && <span className="text-meta text-fg-3 shrink-0">{t("scenes.sectionMissing")}</span>}
        {nSel > 0 && <span className="ml-auto mono text-meta text-accent shrink-0">{t("scenes.sectionSel", { n: nSel })}</span>}
      </button>
    );
  };

  // the section whose header has scrolled out of view stays pinned
  let pinned: Section | null = null;
  if (sections) {
    for (const h of layout.heads) {
      if (h.y < top + 4) pinned = h.s;
      else break;
    }
  }

  return (
    <div className="absolute inset-0">
      <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overflow-x-hidden" data-grid>
        <div style={{ height: layout.total, position: "relative" }}>
          {layout.heads.filter((h) => h.y + HEAD_H > top - over && h.y < top + size.h + over).map((h) => header(h.s, { top: h.y }, false))}
          {cards}
        </div>
      </div>
      {pinned && <div className="absolute top-0 left-0 right-3 h-0">{header(pinned, { top: 4 }, true)}</div>}
    </div>
  );
}
