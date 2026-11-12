import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Floating menu opened at a screen position (context menus, row menus). */
export function Menu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);
  activeRef.current = active;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const enabled = () => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const en = enabled();
        if (!en.length) return;
        const idx = en.indexOf(activeRef.current);
        const next = e.key === "ArrowDown" ? (idx + 1) % en.length : (idx - 1 + en.length) % en.length;
        setActive(en[idx < 0 ? (e.key === "ArrowDown" ? 0 : en.length - 1) : next]);
      } else if (e.key === "Enter" && activeRef.current >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const it = items[activeRef.current];
        onClose();
        it.onClick();
      }
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [items, onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-[60] min-w-[200px] rounded-lg bg-surface-2 border border-line-strong shadow-float py-1 anim-menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div className="my-1 h-px bg-line" />}
          <button
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              it.onClick();
            }}
            className={`w-full text-left h-8 px-3 text-body disabled:opacity-40 ${it.danger ? "text-danger" : "text-fg-1"} ${
              active === i ? "bg-surface-3" : ""
            }`}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}
