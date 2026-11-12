import { create } from "zustand";
import type { Appearance, Project, ShotSize } from "../api";

export interface Trim {
  start: number;
  end: number;
}

/** Everything the user has decided in one project this session. Kept per project, per character. */
export interface Session {
  currentChar: string | null;
  selected: Record<string, ReadonlySet<string>>; // by character id
  focus: Record<string, string | null>; // focused appearance by character id
  trims: Record<string, Trim>; // by appearance id (so they follow an appearance across moves)
}

export interface Filters {
  /** "all", or a source id (ignored when the project has no such source) */
  source: string;
  size: "all" | ShotSize;
  solo: boolean;
  minDur: number;
  sort: "time" | "duration" | "confidence";
}

export const DEFAULT_FILTERS: Filters = { source: "all", size: "all", solo: false, minDur: 0, sort: "time" };

const EMPTY: Session = { currentChar: null, selected: {}, focus: {}, trims: {} };
const EMPTY_SET: ReadonlySet<string> = new Set();

interface WS {
  sessions: Record<string, Session>;
  filters: Filters;
  setFilters: (p: Partial<Filters>) => void;
  setCurrent: (pid: string, cid: string | null) => void;
  setSelection: (pid: string, cid: string, ids: Iterable<string>) => void;
  setFocus: (pid: string, cid: string, aid: string | null) => void;
  setTrim: (pid: string, aid: string, trim: Trim | null) => void;
  /**
   * Bring the session in line with a fresh Project: drop state that refers to things the
   * backend no longer has (after merge / move / rescan / source removal). With `prev`, a
   * character that disappeared hands its selection, focus and "currently viewed" over to the
   * character that took over its scenes (a merge), so a background refresh never loses work.
   */
  reconcile: (project: Project, prev?: Project | null) => void;
}

const upd = (s: Record<string, Session>, pid: string, f: (x: Session) => Session) => ({
  sessions: { ...s, [pid]: f(s[pid] ?? EMPTY) },
});

export const useWS = create<WS>((set) => ({
  sessions: {},
  filters: DEFAULT_FILTERS,
  setFilters: (p) => set((s) => ({ filters: { ...s.filters, ...p } })),
  setCurrent: (pid, cid) => set((s) => upd(s.sessions, pid, (x) => ({ ...x, currentChar: cid }))),
  setSelection: (pid, cid, ids) =>
    set((s) => upd(s.sessions, pid, (x) => ({ ...x, selected: { ...x.selected, [cid]: new Set(ids) } }))),
  setFocus: (pid, cid, aid) => set((s) => upd(s.sessions, pid, (x) => ({ ...x, focus: { ...x.focus, [cid]: aid } }))),
  setTrim: (pid, aid, trim) =>
    set((s) =>
      upd(s.sessions, pid, (x) => {
        const trims = { ...x.trims };
        if (trim) trims[aid] = trim;
        else delete trims[aid];
        return { ...x, trims };
      }),
    ),
  reconcile: (project, prev) =>
    set((s) => {
      const cur = s.sessions[project.id];
      if (!cur) return s;
      const byChar = new Map(project.characters.map((c) => [c.id, new Set(c.appearances.map((a) => a.id))]));
      const allIds = new Set<string>();
      byChar.forEach((ids) => ids.forEach((i) => allIds.add(i)));

      let selectedIn = cur.selected;
      let focusIn = cur.focus;
      let currentIn = cur.currentChar;
      if (prev) {
        const succ = successors(prev, project);
        if (succ.size) {
          selectedIn = { ...cur.selected };
          focusIn = { ...cur.focus };
          succ.forEach((to, from) => {
            const sel = selectedIn[from];
            if (sel?.size) selectedIn[to] = new Set([...(selectedIn[to] ?? []), ...sel]);
            if (focusIn[from] && !focusIn[to]) focusIn[to] = focusIn[from];
            if (currentIn === from) currentIn = to;
          });
        }
      }

      const selected: Session["selected"] = {};
      for (const [cid, set] of Object.entries(selectedIn)) {
        const ids = byChar.get(cid);
        if (!ids) continue;
        const kept = [...set].filter((i) => ids.has(i));
        if (kept.length) selected[cid] = kept.length === set.size ? set : new Set(kept);
      }
      const focus: Session["focus"] = {};
      for (const [cid, aid] of Object.entries(focusIn)) {
        if (aid && byChar.get(cid)?.has(aid)) focus[cid] = aid;
      }
      const trims: Session["trims"] = {};
      for (const [aid, tr] of Object.entries(cur.trims)) if (allIds.has(aid)) trims[aid] = tr;
      const currentChar = currentIn && byChar.has(currentIn) ? currentIn : null;
      return { sessions: { ...s.sessions, [project.id]: { currentChar, selected, focus, trims } } };
    }),
}));

/**
 * For every character of `prev` that is gone from `next`, the character that now holds
 * most of its scenes (appearance ids are stable). Characters whose scenes went nowhere
 * (e.g. their video was removed) have no successor.
 */
export function successors(prev: Project, next: Project): Map<string, string> {
  const out = new Map<string, string>();
  const nextIds = new Set(next.characters.map((c) => c.id));
  const owner = new Map<string, string>();
  let lost = 0;
  for (const c of prev.characters) if (!nextIds.has(c.id)) lost++;
  if (!lost) return out;
  for (const c of next.characters) for (const a of c.appearances) owner.set(a.id, c.id);
  for (const c of prev.characters) {
    if (nextIds.has(c.id)) continue;
    const votes = new Map<string, number>();
    for (const a of c.appearances) {
      const o = owner.get(a.id);
      if (o) votes.set(o, (votes.get(o) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    votes.forEach((n, id) => {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    });
    if (best) out.set(c.id, best);
  }
  return out;
}

export const sessionOf = (s: WS, pid: string): Session => s.sessions[pid] ?? EMPTY;
export const selectedOf = (sess: Session, cid: string | null): ReadonlySet<string> => (cid ? (sess.selected[cid] ?? EMPTY_SET) : EMPTY_SET);

/** Effective [start, end] of an appearance after trimming. */
export function effective(a: Appearance, trims: Session["trims"]): Trim {
  return trims[a.id] ?? { start: a.start, end: a.end };
}
