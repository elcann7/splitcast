import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";
import { useT } from "../i18n";

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** false while something is running that must not be dismissed by accident */
  dismissable?: boolean;
  /** hide the close X (e.g. for progress views) */
  hideClose?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, width = 520, dismissable = true, hideClose }: Props) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const auto = el?.querySelector<HTMLElement>("[data-autofocus]");
    (auto ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!el.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [dismissable]);

  return (
    <div
      data-dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 anim-fade p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={{ width }}
        className="max-w-full max-h-full flex flex-col outline-none focus-visible:outline-none rounded-xl bg-surface-1 border border-line shadow-float anim-dialog"
      >
        <div className="flex items-center justify-between h-12 pl-5 pr-3 border-b border-line shrink-0">
          <h2 className="text-section font-semibold">{title}</h2>
          {!hideClose && (
            <IconButton size="sm" onClick={onClose} disabled={!dismissable} aria-label={t("common.close")} title={t("common.close")}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          )}
        </div>
        <div className="px-5 py-4 overflow-y-auto min-h-0">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 h-14 border-t border-line shrink-0">{footer}</div>}
      </div>
    </div>
  );
}
