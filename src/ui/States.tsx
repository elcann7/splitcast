import type { ReactNode } from "react";
import { useT } from "../i18n";
import { Button } from "./Button";

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      role="status"
      className="inline-block rounded-full border-2 border-line-strong border-t-fg-2 anim-spin shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

export function LoadingBlock({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="h-full w-full flex items-center justify-center gap-3 text-fg-2">
      <Spinner />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}

interface StateProps {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  className?: string;
}

/** Empty and error messages share one layout: what happened, what you can do. */
export function StateMessage({ title, body, action, tone = "neutral", className = "" }: StateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center gap-2 px-8 h-full ${className}`}>
      <div className={`text-section font-medium ${tone === "error" ? "text-fg-1" : "text-fg-1"}`}>{title}</div>
      {body && <div className="text-body text-fg-2 max-w-[460px] leading-relaxed">{body}</div>}
      {action && <div className="mt-2 flex gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, body, onRetry }: { title: string; body?: ReactNode; onRetry?: () => void }) {
  const t = useT();
  return (
    <StateMessage
      tone="error"
      title={title}
      body={body}
      action={onRetry && <Button onClick={onRetry}>{t("common.retry")}</Button>}
    />
  );
}

export function Progress({ value, className = "" }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={`h-1 rounded-full bg-surface-3 overflow-hidden ${className}`} role="progressbar" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={`h-full bg-accent rounded-full ${v > 0 && v < 1 ? "progress-live" : ""}`}
        style={{ width: `${v * 100}%`, transition: "width 400ms linear" }}
      />
    </div>
  );
}
