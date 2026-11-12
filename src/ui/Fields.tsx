import { Children, forwardRef, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChangeEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Check, ChevronDown } from "lucide-react";

const fieldBase =
  "h-8 rounded bg-surface-2 border border-line-strong px-2.5 text-body text-fg-1 placeholder:text-fg-3 t-fast hover:border-fg-3 focus:border-fg-3 disabled:opacity-40";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = "", ...rest },
  ref,
) {
  return <input ref={ref} className={`${fieldBase} w-full ${className}`} {...rest} />;
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  wrapClass?: string;
}

const ROW_H = 30;

/**
 * A dropdown that looks like the rest of the app (the native one is drawn by the OS).
 * Takes the same props as <select> with <option> children, so it is a drop-in replacement:
 * `onChange` receives an event-like object whose `target.value` is the chosen value.
 */
export function Select({ className = "", wrapClass = "", children, value, onChange, disabled, title, "aria-label": ariaLabel }: SelectProps) {
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((el) => {
      const p = el.props as { value?: string | number; children?: ReactNode; disabled?: boolean };
      return { value: String(p.value ?? ""), label: p.children, disabled: !!p.disabled };
    });
  const current = options.findIndex((o) => o.value === String(value ?? ""));
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<null | { left: number; edge: number; width: number; up: boolean; maxH: number }>(null);
  const [active, setActiveState] = useState(-1);
  // the ref is the truth for key handling: two quick key presses must not read a stale index
  const activeRef = useRef(-1);
  const setActive = (i: number) => {
    activeRef.current = i;
    setActiveState(i);
  };

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    setPop(null);
    btn.current?.focus();
    if (o.value !== String(value ?? "")) {
      onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as ChangeEvent<HTMLSelectElement>);
    }
  };
  const live = useRef({ pick, n: options.length, options });
  live.current = { pick, n: options.length, options };

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const want = options.length * ROW_H + 10;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < Math.min(want, 150) && above > below;
    setActive(current >= 0 ? current : 0);
    setPop({
      left: r.left,
      edge: up ? window.innerHeight - r.top + 4 : r.bottom + 4,
      width: r.width,
      up,
      maxH: Math.max(96, Math.min(want, up ? above : below, 340)),
    });
  };

  const isOpen = pop !== null;
  useEffect(() => {
    if (!isOpen) return;
    const step = (from: number, d: number) => {
      const { n, options: os } = live.current;
      for (let k = 1; k <= n; k++) {
        const i = (from + d * k + n * n) % n;
        if (!os[i].disabled) return i;
      }
      return from;
    };
    // capture on window: ahead of the dialog's Escape handler and the workspace's arrow keys
    const key = (e: KeyboardEvent) => {
      const a = activeRef.current;
      const { n } = live.current;
      if (e.key === "ArrowDown") setActive(step(a, 1));
      else if (e.key === "ArrowUp") setActive(step(a, -1));
      else if (e.key === "Home") setActive(step(-1, 1));
      else if (e.key === "End") setActive(step(n, -1));
      else if (e.key === "Enter" || e.key === " ") live.current.pick(a);
      else if (e.key === "Escape" || e.key === "Tab") {
        setPop(null);
        btn.current?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const inside = (t: EventTarget | null) => t instanceof Node && (!!list.current?.contains(t) || !!btn.current?.contains(t));
    const away = (e: MouseEvent) => {
      if (!inside(e.target)) setPop(null);
    };
    const scrolled = (e: Event) => {
      if (!(e.target instanceof Node && list.current?.contains(e.target))) setPop(null);
    };
    const close = () => setPop(null);
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", away, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [isOpen, active]);

  return (
    <span className={`relative inline-flex ${wrapClass}`}>
      <button
        ref={btn}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (isOpen ? setPop(null) : show())}
        onKeyDown={(e) => {
          if (!isOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            e.stopPropagation();
            show();
          }
        }}
        className={`${fieldBase} w-full pr-7 text-left truncate ${isOpen ? "border-fg-3" : ""} ${className}`}
      >
        {current >= 0 ? options[current].label : ""}
      </button>
      <ChevronDown
        size={14}
        strokeWidth={1.5}
        className={`absolute right-2 top-1/2 -translate-y-1/2 text-fg-2 pointer-events-none t-fast ${isOpen ? "rotate-180 text-fg-1" : ""}`}
      />
      {pop &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            data-select-pop
            style={{
              position: "fixed",
              left: pop.left,
              minWidth: Math.max(pop.width, 132),
              maxHeight: pop.maxH,
              transformOrigin: pop.up ? "bottom left" : "top left",
              ...(pop.up ? { bottom: pop.edge } : { top: pop.edge }),
            }}
            className="z-[80] overflow-y-auto rounded-lg bg-surface-2 border border-line-strong shadow-float p-1 anim-menu"
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={i === current}
                data-active={i === active}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                style={{ height: ROW_H }}
                className={`flex items-center gap-2 pl-2 pr-3 rounded text-body whitespace-nowrap t-fast ${o.disabled ? "opacity-40" : ""} ${
                  i === active ? "bg-surface-3 text-fg-1" : i === current ? "text-fg-1" : "text-fg-2"
                }`}
              >
                <Check size={14} strokeWidth={2} className={`shrink-0 ${i === current ? "text-accent" : "opacity-0"}`} />
                {o.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

interface CheckProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  compact?: boolean;
}
export function Checkbox({ checked, onChange, label, hint, disabled, compact }: CheckProps) {
  return (
    <label className={`flex ${compact ? "items-center gap-2" : "items-start gap-2.5"} ${disabled ? "opacity-40" : ""}`}>
      <input type="checkbox" className="sr-only peer" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        className={`${compact ? "" : "mt-px"} h-4 w-4 shrink-0 rounded-sm border flex items-center justify-center t-fast peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
          checked ? "bg-fg-1 border-fg-1 text-surface-0" : "bg-surface-2 border-line-strong"
        }`}
      >
        {checked && <Check size={12} strokeWidth={2.5} />}
      </span>
      <span className="min-w-0">
        <span className={`block ${compact ? "text-meta text-fg-2" : "text-body text-fg-1"}`}>{label}</span>
        {hint && <span className="block text-meta text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

interface SegProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  size?: "md" | "sm";
  ariaLabel?: string;
}
export function Segmented<T extends string>({ value, onChange, options, disabled, size = "md", ariaLabel }: SegProps<T>) {
  // the highlight slides to the chosen option instead of jumping
  const box = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const labels = options.map((o) => o.label).join("|");
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [value, labels, size]);
  return (
    <div
      ref={box}
      role="radiogroup"
      aria-label={ariaLabel}
      className={`relative inline-flex rounded border border-line-strong bg-surface-2 p-0.5 gap-0.5 ${size === "md" ? "h-8" : "h-7"} ${disabled ? "opacity-40 pointer-events-none" : ""}`}
    >
      {pill && <span className="seg-pill absolute top-0.5 bottom-0.5 rounded-sm bg-surface-3" style={{ left: pill.left, width: pill.width }} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`relative px-3 rounded-sm text-body t-fast ${size === "sm" ? "text-meta px-2.5" : ""} ${
            value === o.value ? "text-fg-1 font-medium" : "text-fg-2 hover:text-fg-1"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-meta text-fg-2">{label}</div>
      {children}
      {hint && <div className="text-meta text-fg-3">{hint}</div>}
    </div>
  );
}
