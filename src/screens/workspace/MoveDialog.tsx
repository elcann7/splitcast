import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Input } from "../../ui/Fields";
import { fmtClock } from "../../lib/time";
import { useWorkspace } from "./ctx";

/** Choose which character a set of appearances belongs to ("new" creates one). */
export function MoveDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const t = useT();
  const { project, char, run, focusAppearance, setSelection, selected } = useWorkspace();
  const [target, setTarget] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const others = useMemo(
    () =>
      project.characters.filter((c) => c.id !== char?.id && c.name.toLowerCase().includes(q.trim().toLowerCase())),
    [project.characters, char?.id, q],
  );

  async function go(tid: string) {
    onClose();
    const moving = new Set(ids);
    const ok = await run(t("scenes.moveErr"), () => api.moveAppearances(project.id, { appearanceIds: ids, targetCharacterId: tid }));
    if (ok) {
      // the moved scenes left this character: drop them from its selection, keep the rest
      setSelection([...selected].filter((i) => !moving.has(i)));
      focusAppearance(null);
    }
  }

  return (
    <Dialog
      title={t("scenes.moveTitle")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!target} onClick={() => target && go(target)}>
            {t("scenes.moveBtn")}
          </Button>
        </>
      }
    >
      <p className="text-fg-2 mb-3">{t("scenes.moveBody", { n: ids.length })}</p>
      <Input data-autofocus placeholder={t("scenes.moveSearch")} value={q} onChange={(e) => setQ(e.target.value)} />
      <div role="radiogroup" className="mt-3 flex flex-col gap-1.5 max-h-[300px] overflow-y-auto">
        <button
          role="radio"
          aria-checked={target === "new"}
          onClick={() => setTarget("new")}
          onDoubleClick={() => go("new")}
          className={`flex items-center gap-3 h-12 px-3 rounded-lg border text-left t-fast ${
            target === "new" ? "border-accent bg-accent-dim" : "border-line-strong bg-surface-2 hover:bg-surface-3"
          }`}
        >
          <span className="h-9 w-9 rounded-lg border border-dashed border-fg-3 flex items-center justify-center text-fg-2">
            <Plus size={16} strokeWidth={1.5} />
          </span>
          <span className="font-medium">{t("scenes.moveNew")}</span>
        </button>
        {others.map((c) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={target === c.id}
            onClick={() => setTarget(c.id)}
            onDoubleClick={() => go(c.id)}
            className={`flex items-center gap-3 h-12 px-3 rounded-lg border text-left t-fast ${
              target === c.id ? "border-accent bg-accent-dim" : "border-line-strong bg-surface-2 hover:bg-surface-3"
            }`}
          >
            <img src={c.thumb} alt="" className="h-9 w-9 rounded-lg object-cover" />
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{c.name}</div>
              <div className="mono text-meta text-fg-2">{t("cast.rowMeta", { time: fmtClock(c.screenTime), n: c.appearanceCount })}</div>
            </div>
          </button>
        ))}
        {others.length === 0 && q && <div className="text-fg-3 text-meta py-2">{t("scenes.moveNone")}</div>}
      </div>
    </Dialog>
  );
}
