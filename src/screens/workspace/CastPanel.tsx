import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Eye, EyeOff } from "lucide-react";
import { api } from "../../api";
import type { Character } from "../../api";
import { useT } from "../../i18n";
import { Button, IconButton } from "../../ui/Button";
import { Input } from "../../ui/Fields";
import { Dialog } from "../../ui/Dialog";
import { StateMessage } from "../../ui/States";
import { fmtClock } from "../../lib/time";
import { useWS, sessionOf } from "../../store/workspace";
import { useWorkspace } from "./ctx";

interface RowProps {
  c: Character;
  current: boolean;
  checked: boolean;
  editing: boolean;
  onClick: (e: React.MouseEvent, id: string) => void;
  onStartEdit: (id: string) => void;
  onCommit: (id: string, name: string | null) => void;
  onToggleHidden: (c: Character) => void;
  /** videos in the project; above one, the row says in how many the character appears */
  totalSources: number;
  /** position in its list, for the staggered entrance */
  i: number;
}

const Row = memo(function Row({ c, current, checked, editing, onClick, onStartEdit, onCommit, onToggleHidden, totalSources, i }: RowProps) {
  const t = useT();
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name, editing]);
  return (
    <div
      role="option"
      aria-selected={checked}
      data-cast-row={c.id}
      onClick={(e) => onClick(e, c.id)}
      style={{ "--i": i } as React.CSSProperties}
      className={`anim-rise group relative h-14 flex items-center gap-3 pl-3 pr-1.5 rounded-lg t-fast ${
        checked ? "bg-accent-dim" : "hover:bg-surface-2"
      } ${c.hidden ? "opacity-60" : ""}`}
    >
      {current && <span className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-accent" />}
      <img src={c.thumb} alt="" loading="lazy" decoding="async" draggable={false} className="h-11 w-11 rounded-lg object-cover bg-surface-2 shrink-0 transition-transform duration-300 ease-out group-hover:scale-[1.06]" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => onCommit(c.id, name.trim() || null)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onCommit(c.id, name.trim() || null);
              if (e.key === "Escape") onCommit(c.id, null);
            }}
            className="!h-7 text-body"
          />
        ) : (
          <div
            className="text-body font-medium truncate"
            title={t("cast.renameHint")}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onStartEdit(c.id);
            }}
          >
            {c.name}
          </div>
        )}
        <div
          className="mono text-meta text-fg-2 truncate mt-0.5"
          title={totalSources > 1 ? t("cast.inVideos", { s: c.sourceCount, total: totalSources }) : undefined}
        >
          {totalSources > 1
            ? t("cast.rowMetaSrc", { time: fmtClock(c.screenTime), n: c.appearanceCount, s: c.sourceCount, total: totalSources })
            : t("cast.rowMeta", { time: fmtClock(c.screenTime), n: c.appearanceCount })}
        </div>
      </div>
      {!editing && (
        <IconButton
          size="sm"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={c.hidden ? t("cast.unhide") : t("cast.hide")}
          title={c.hidden ? t("cast.unhide") : t("cast.hide")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden(c);
          }}
        >
          {c.hidden ? <Eye size={16} strokeWidth={1.5} /> : <EyeOff size={16} strokeWidth={1.5} />}
        </IconButton>
      )}
    </div>
  );
});

function GroupHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full flex items-center gap-1.5 h-8 px-2 mt-2 text-meta text-fg-2 hover:text-fg-1 rounded t-fast"
    >
      <ChevronRight size={14} strokeWidth={1.5} className={`t-fast ${open ? "rotate-90" : ""}`} />
      {label}
    </button>
  );
}

export function CastPanel() {
  const t = useT();
  const { project, char, setCurrent, run, setSelection } = useWorkspace();
  const pid = project.id;
  const [castSel, setCastSel] = useState<string[]>([]);
  const [minorOpen, setMinorOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const anchor = useRef<string | null>(null);

  const { main, minor, hidden } = useMemo(() => {
    const cs = project.characters;
    return {
      main: cs.filter((c) => !c.hidden && !c.isMinor),
      minor: cs.filter((c) => !c.hidden && c.isMinor),
      hidden: cs.filter((c) => c.hidden),
    };
  }, [project.characters]);

  // open the group that holds the current character
  useEffect(() => {
    if (!char) return;
    if (char.hidden) setHiddenOpen(true);
    else if (char.isMinor) setMinorOpen(true);
  }, [char?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => [...main, ...(minorOpen ? minor : []), ...(hiddenOpen ? hidden : [])], [main, minor, hidden, minorOpen, hiddenOpen]);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  const selSet = useMemo(() => {
    const ids = new Set(project.characters.map((c) => c.id));
    const s = new Set(castSel.filter((i) => ids.has(i)));
    if (char && s.size === 0) s.add(char.id);
    return s;
  }, [castSel, project.characters, char]);

  function onClick(e: React.MouseEvent, id: string) {
    const f = flatRef.current;
    if (e.shiftKey && anchor.current) {
      const a = f.findIndex((c) => c.id === anchor.current);
      const b = f.findIndex((c) => c.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setCastSel(f.slice(lo, hi + 1).map((c) => c.id));
        setCurrent(id);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      anchor.current = id;
      const has = selSet.has(id);
      const next = has ? [...selSet].filter((x) => x !== id) : [...selSet, id];
      setCastSel(next);
      if (!has) setCurrent(id);
      else if (id === char?.id && next.length) setCurrent(next[next.length - 1]);
      return;
    }
    anchor.current = id;
    setCastSel([id]);
    setCurrent(id);
  }

  async function commitName(id: string, name: string | null) {
    setEditing(null);
    const c = project.characters.find((x) => x.id === id);
    if (name && c && name !== c.name) await run(t("ws.renameErr"), () => api.patchCharacter(pid, id, { name }));
  }

  async function toggleHidden(c: Character) {
    const ok = await run(t("ws.actionErr"), () => api.patchCharacter(pid, c.id, { hidden: !c.hidden }));
    if (ok && !c.hidden && char?.id === c.id) {
      const next = main.find((x) => x.id !== c.id) ?? minor[0];
      if (next) setCurrent(next.id);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing) return;
    const f = flatRef.current;
    const i = f.findIndex((c) => c.id === char?.id);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = f[Math.max(0, Math.min(f.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (!n) return;
      if (e.shiftKey) {
        const a = f.findIndex((c) => c.id === (anchor.current ?? char?.id));
        const b = f.indexOf(n);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setCastSel(f.slice(lo, hi + 1).map((c) => c.id));
      } else {
        anchor.current = n.id;
        setCastSel([n.id]);
      }
      setCurrent(n.id);
      document.querySelector(`[data-cast-row="${CSS.escape(n.id)}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "F2" && char) {
      e.preventDefault();
      setEditing(char.id);
    }
  }

  const renderRows = (cs: Character[]) =>
    cs.map((c, i) => (
      <Row
        i={i}
        key={c.id}
        c={c}
        current={c.id === char?.id}
        checked={selSet.has(c.id)}
        editing={editing === c.id}
        onClick={onClick}
        onStartEdit={setEditing}
        onCommit={commitName}
        onToggleHidden={toggleHidden}
        totalSources={project.sources.length}
      />
    ));

  const multi = selSet.size >= 2;
  const selChars = project.characters.filter((c) => selSet.has(c.id));

  return (
    <aside data-cast className="w-[280px] shrink-0 flex flex-col bg-surface-1 border-r border-line min-h-0">
      <div className="h-11 shrink-0 flex items-center justify-between px-4 border-b border-line">
        <h2 className="text-section font-semibold">{t("cast.title")}</h2>
        <span className="mono text-meta text-fg-3">{project.characters.length}</span>
      </div>
      {multi && (
        <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-line bg-surface-2 anim-fade">
          <span className="mono text-meta text-fg-2 flex-1">{t("cast.selectedN", { n: selSet.size })}</span>
          <Button size="sm" variant="ghost" onClick={() => setCastSel(char ? [char.id] : [])}>
            {t("cast.clear")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setMergeOpen(true)}>
            {t("cast.merge")}
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 outline-none" tabIndex={0} role="listbox" aria-multiselectable onKeyDown={onKeyDown}>
        {project.characters.length === 0 ? (
          <StateMessage title={t("cast.emptyTitle")} body={t("cast.emptyBody")} />
        ) : (
          <>
            {renderRows(main)}
            {minor.length > 0 && (
              <>
                <GroupHeader label={t("cast.minor", { n: minor.length })} open={minorOpen} onToggle={() => setMinorOpen((v) => !v)} />
                {minorOpen && renderRows(minor)}
              </>
            )}
            {hidden.length > 0 && (
              <>
                <GroupHeader label={t("cast.hidden", { n: hidden.length })} open={hiddenOpen} onToggle={() => setHiddenOpen((v) => !v)} />
                {hiddenOpen && renderRows(hidden)}
              </>
            )}
          </>
        )}
      </div>

      {mergeOpen && (
        <MergeDialog
          chars={selChars}
          onClose={() => setMergeOpen(false)}
          onMerge={async (targetId) => {
            const sess = sessionOf(useWS.getState(), pid);
            const union = new Set<string>();
            selChars.forEach((c) => (sess.selected[c.id] ?? new Set<string>()).forEach((i) => union.add(i)));
            const sources = selChars.filter((c) => c.id !== targetId).map((c) => c.id);
            setMergeOpen(false);
            const ok = await run(t("cast.mergeErr"), () => api.mergeCharacters(pid, { sourceIds: sources, targetId }));
            if (ok) {
              setCastSel([targetId]);
              setCurrent(targetId);
              if (union.size) setSelection(union, targetId);
            }
          }}
        />
      )}
    </aside>
  );
}

function MergeDialog({ chars, onClose, onMerge }: { chars: Character[]; onClose: () => void; onMerge: (targetId: string) => void }) {
  const t = useT();
  // most screen time is the sensible default survivor
  const [target, setTarget] = useState(() => [...chars].sort((a, b) => b.screenTime - a.screenTime)[0]?.id);
  return (
    <Dialog
      title={t("cast.mergeTitle")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => onMerge(target)} disabled={!target}>
            {t("cast.merge")}
          </Button>
        </>
      }
    >
      <p className="text-fg-2 mb-3">{t("cast.mergeBody", { n: chars.length })}</p>
      <div role="radiogroup" className="flex flex-col gap-1.5 max-h-[280px] overflow-y-auto">
        {chars.map((c) => {
          const sel = c.id === target;
          return (
            <button
              key={c.id}
              role="radio"
              aria-checked={sel}
              data-autofocus={sel ? "" : undefined}
              onClick={() => setTarget(c.id)}
              onDoubleClick={() => onMerge(c.id)}
              className={`flex items-center gap-3 h-14 px-3 rounded-lg border text-left t-fast ${
                sel ? "border-accent bg-accent-dim" : "border-line-strong bg-surface-2 hover:bg-surface-3"
              }`}
            >
              <img src={c.thumb} alt="" className="h-11 w-11 rounded-lg object-cover" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{c.name}</div>
                <div className="mono text-meta text-fg-2">{t("cast.rowMeta", { time: fmtClock(c.screenTime), n: c.appearanceCount })}</div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-meta text-fg-3 mt-3 leading-snug">{t("cast.mergeNote")}</p>
    </Dialog>
  );
}
