import { useEffect, useRef, useState } from "react";

/** A number that runs to its new value instead of jumping (ease-out). `undefined` passes through. */
export function useCountUp(target: number | undefined, ms = 450): number | undefined {
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  useEffect(() => {
    if (target === undefined) {
      shown.current = undefined;
      setValue(undefined);
      return;
    }
    const from = shown.current ?? 0;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const cur = Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      shown.current = cur;
      setValue(cur);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
