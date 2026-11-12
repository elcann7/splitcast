import { useCallback, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { Appearance } from "../../api";
import { useT } from "../../i18n";
import { Button } from "../../ui/Button";
import { Checkbox, Segmented, Select } from "../../ui/Fields";
import { Menu } from "../../ui/Menu";
import type { MenuItem } from "../../ui/Menu";
import { StateMessage } from "../../ui/States";
import { fmtClock } from "../../lib/time";
import { bestScenes } from "../../lib/sceneScore";
import { DEFAULT_FILTERS, useWS } from "../../store/workspace";
import type { Filters } from "../../store/workspace";
import { useWorkspace } from "./ctx";
import { SceneGrid } from "./SceneGrid";
import type { Section } from "./SceneGrid";
import { AppearanceTrack } from "./AppearanceTrack";

const MIN_DURS = [0, 1, 2, 3, 5, 8];

export function Scenes() {
  const t = useT();
  const w = useWorkspace();
  const { project, char, list, selected, focusId, trims, filters, setSelection, focusAppearance, setTrim, openMove } = w;
  const setFilters = useWS((s) => s.setFilters);
  const anchor = useRef<{ cid: string; index: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; a: Appearance } | null>(null);
  const [bestMenu, setBestMenu] = useState<{ x: number; y: number } | null>(null);

  const isDefault = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).every((k) => filters[k] === DEFAULT_FILTERS[k]);

  const selectedDur = useMemo(() => {
    if (!char) return 0;
    let s = 0;
    for (const a of char.appearances) {
      if (!selected.has(a.id)) continue;
      const tr = trims[a.id];
      s += tr ? tr.end - tr.start : a.end - a.start;
    }
    return s;
  }, [char, selected, trims]);

  const visibleIds = useMemo(() => new Set(list.map((a) => a.id)), [list]);
  const behindFilter = useMemo(() => {
    let n = 0;
    selected.forEach((id) => {
      if (!visibleIds.has(id)) n++;
    });
    return n;
  }, [selected, visibleIds]);

  const onCardClick = useCallback(
    (a: Appearance, index: number, e: React.MouseEvent) => {
      if (!char) return;
      if (e.shiftKey && anchor.current && anchor.current.cid === char.id) {
        const lo = Math.min(anchor.current.index, index);
        const hi = Math.max(anchor.current.index, index);
        const next = new Set(selected);
        for (let i = lo; i <= hi; i++) next.add(list[i].id);
        setSelection(next);
      } else {
        const next = new Set(selected);
        if (next.has(a.id)) next.delete(a.id);
        else next.add(a.id);
        setSelection(next);
        anchor.current = { cid: char.id, index };
      }
      focusAppearance(a.id);
    },
    [char, selected, list, setSelection, focusAppearance],
  );

  const onCardContext = useCallback((a: Appearance, _i: number, e: React.MouseEvent) => {
    setMenu({ x: e.clientX, y: e.clientY, a });
  }, []);

  const multi = project.sources.length > 1;
  const srcValue = project.sources.some((s) => s.id === filters.source) ? filters.source : "all";
  // scenes are grouped under their video while they are in time order (the order they come in)
  const sections = useMemo(() => {
    if (!multi || filters.sort !== "time") return null;
    const byId = new Map(project.sources.map((s) => [s.id, s]));
    const out: Section[] = [];
    list.forEach((a, i) => {
      const last = out[out.length - 1];
      if (last && last.key === a.sourceId) last.count++;
      else {
        const s = byId.get(a.sourceId);
        out.push({ key: a.sourceId, label: s?.label ?? "", start: i, count: 1, missing: !!s?.sourceMissing });
      }
    });
    return out;
  }, [multi, filters.sort, list, project.sources]);
  const noPreview = useMemo(() => {
    const gone = new Set(project.sources.filter((s) => s.sourceMissing).map((s) => s.id));
    if (!gone.size || !char) return null;
    return new Set(char.appearances.filter((a) => gone.has(a.sourceId)).map((a) => a.id));
  }, [project.sources, char]);
  const onSectionToggle = useCallback(
    (s: Section) => {
      const ids = list.slice(s.start, s.start + s.count).map((a) => a.id);
      const next = new Set(selected);
      const all = ids.every((id) => next.has(id));
      ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
      setSelection(next);
    },
    [list, selected, setSelection],
  );

  const menuItems = (a: Appearance): MenuItem[] => {
    const isSel = selected.has(a.id);
    const targets = isSel ? [...selected] : [a.id];
    const items: MenuItem[] = [
      {
        label: isSel ? t("scenes.menuUnselect") : t("scenes.menuSelect"),
        onClick: () => {
          const next = new Set(selected);
          if (isSel) next.delete(a.id);
          else next.add(a.id);
          setSelection(next);
        },
      },
      { label: t("scenes.menuMove", { n: targets.length }), onClick: () => openMove(targets) },
    ];
    if (trims[a.id]) items.push({ label: t("scenes.menuResetTrim"), onClick: () => setTrim(a.id, null), separatorBefore: true });
    return items;
  };

  if (!char) {
    return (
      <section className="flex-1 min-w-0 flex flex-col">
        <StateMessage title={project.characters.length ? t("scenes.noChar") : t("cast.emptyTitle")} />
      </section>
    );
  }

  const total = char.appearances.length;
  const nSel = selected.size;

  return (
    <section className="cq flex-1 min-w-0 flex flex-col min-h-0 bg-surface-0">
      <div className="shrink-0 border-b border-line">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 min-h-12">
          <div className="flex items-baseline gap-3 min-w-0">
            <h2 className="text-section font-semibold truncate">{char.name}</h2>
            <span className="mono text-meta text-fg-3 shrink-0">
              {multi ? t("scenes.countSrc", { n: total, s: char.sourceCount, total: project.sources.length }) : t("scenes.count", { n: total })}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="mono text-meta text-fg-2 whitespace-nowrap">
              {nSel > 0 ? <span className="text-fg-1">{t("scenes.selected", { n: nSel, dur: fmtClock(selectedDur) })}</span> : t("scenes.noneSelected")}
              {behindFilter > 0 && <span className="text-fg-3"> · {t("scenes.behindFilter", { n: behindFilter })}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={list.length === 0}
                title="Ctrl+A"
                onClick={() => setSelection(new Set([...selected, ...list.map((a) => a.id)]))}
              >
                {t("scenes.selectAll")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={list.length === 0}
                title={t("scenes.bestHint")}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setBestMenu({ x: r.left, y: r.bottom + 4 });
                }}
              >
                <Sparkles size={14} strokeWidth={1.5} />
                {t("scenes.best")}
              </Button>
              <Button size="sm" variant="ghost" disabled={nSel === 0} title="Esc" onClick={() => setSelection([])}>
                <span className="cq-long">{t("scenes.clearSel")}</span>
                <span className="cq-short">{t("scenes.clearShort")}</span>
              </Button>
              <Button size="sm" variant="secondary" disabled={nSel === 0} onClick={() => openMove([...selected])}>
                <span className="cq-long">{t("scenes.move")}</span>
                <span className="cq-short">{t("scenes.moveShort")}</span>
              </Button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 min-h-11 border-t border-line">
          {multi && (
            <label className="flex items-center" title={t("scenes.source")}>
              <Select value={srcValue} aria-label={t("scenes.source")} onChange={(e) => setFilters({ source: e.target.value })} className="!h-7 text-meta" wrapClass="w-[156px]">
                <option value="all">{t("scenes.source.all")}</option>
                {project.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <Segmented<Filters["size"]>
            size="sm"
            ariaLabel={t("scenes.size")}
            value={filters.size}
            onChange={(size) => setFilters({ size })}
            options={[
              { value: "all", label: t("scenes.size.all") },
              { value: "closeup", label: t("scenes.size.closeup") },
              { value: "medium", label: t("scenes.size.medium") },
              { value: "wide", label: t("scenes.size.wide") },
            ]}
          />
          <Checkbox compact checked={filters.solo} onChange={(solo) => setFilters({ solo })} label={t("scenes.solo")} />
          <label className="flex items-center gap-2 text-meta text-fg-2" title={t("scenes.minDur")}>
            {t("scenes.minDur")}
            <Select
              value={String(filters.minDur)}
              onChange={(e) => setFilters({ minDur: Number(e.target.value) })}
              className="!h-7 text-meta"
              wrapClass="w-[104px]"
            >
              {MIN_DURS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? t("scenes.minDurAny") : t("scenes.minDurN", { n: d })}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-meta text-fg-2" title={t("scenes.sort")}>
            {t("scenes.sort")}
            <Select
              value={filters.sort}
              onChange={(e) => setFilters({ sort: e.target.value as Filters["sort"] })}
              className="!h-7 text-meta"
              wrapClass="w-[112px]"
            >
              <option value="time">{t("scenes.sort.time")}</option>
              <option value="duration">{t("scenes.sort.duration")}</option>
              <option value="confidence">{t("scenes.sort.confidence")}</option>
            </Select>
          </label>
          {!isDefault && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="mono text-meta text-fg-3">
                {list.length} / {total}
              </span>
              <Button size="sm" variant="ghost" onClick={w.resetFilters}>
                {t("scenes.resetFilters")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {total === 0 ? (
          <StateMessage title={t("scenes.empty")} />
        ) : list.length === 0 ? (
          <StateMessage
            title={t("scenes.noMatch")}
            action={
              <Button onClick={w.resetFilters}>{t("scenes.resetFilters")}</Button>
            }
          />
        ) : (
          <SceneGrid
            items={list}
            selected={selected}
            focusId={focusId}
            trims={trims}
            projectId={project.id}
            sections={sections}
            noPreview={noPreview}
            onSectionToggle={onSectionToggle}
            colsRef={w.colsRef}
            scrollReq={w.scrollReq}
            onCardClick={onCardClick}
            onCardContext={onCardContext}
          />
        )}
      </div>

      <AppearanceTrack
        all={char.appearances}
        visibleIds={visibleIds}
        selected={selected}
        focusId={focusId}
        sources={project.sources}
        onPick={(a, visible) => {
          if (!visible) w.resetFilters();
          focusAppearance(a.id, "center");
        }}
      />

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.a)} onClose={() => setMenu(null)} />}
      {bestMenu && (
        <Menu
          x={bestMenu.x}
          y={bestMenu.y}
          items={[25, 50, 75].map((p) => ({ label: t("scenes.bestPct", { p }), onClick: () => setSelection(bestScenes(list, p / 100)) }))}
          onClose={() => setBestMenu(null)}
        />
      )}
    </section>
  );
}
