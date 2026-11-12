import { X } from "lucide-react";
import { useApp } from "../store/app";
import { useT } from "../i18n";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const t = useT();
  if (!toasts.length) return null;
  return (
    <div className="fixed left-4 bottom-4 z-[70] flex flex-col gap-2 max-w-[460px]" aria-live="polite">
      {toasts.map((x) => (
        <div
          key={x.id}
          className="flex items-start gap-3 rounded-lg bg-surface-2 border border-line-strong shadow-float pl-3.5 pr-2 py-2.5 anim-toast"
        >
          <div className={`text-body leading-snug pt-px ${x.kind === "error" ? "text-danger" : "text-fg-1"}`}>{x.text}</div>
          <button
            onClick={() => dismiss(x.id)}
            aria-label={t("common.close")}
            className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-fg-3 hover:text-fg-1 hover:bg-surface-3"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}
