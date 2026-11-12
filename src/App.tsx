import { useEffect } from "react";
import { Library as LibraryIcon, Settings as SettingsIcon } from "lucide-react";
import { MOCK } from "./api";
import { applyDocLang, useApp } from "./store/app";
import { useT } from "./i18n";
import { navigate, paths, useRoute } from "./lib/router";
import { Library } from "./screens/Library";
import { SettingsScreen } from "./screens/Settings";
import { ProjectScreen } from "./screens/Project";
import { Toasts } from "./ui/Toasts";
import { Button } from "./ui/Button";
import { LoadingBlock, StateMessage } from "./ui/States";

function Rail({ active }: { active: "library" | "settings" }) {
  const t = useT();
  const item = (key: "library" | "settings", label: string, icon: JSX.Element, to: string) => (
    <button
      onClick={() => navigate(to)}
      title={label}
      aria-label={label}
      aria-current={active === key ? "page" : undefined}
      className={`relative h-10 w-10 rounded flex items-center justify-center t-fast ${
        active === key ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:bg-surface-2 hover:text-fg-1"
      }`}
    >
      {active === key && <span className="absolute -left-[8px] top-2 bottom-2 w-0.5 rounded-full bg-accent" />}
      {icon}
    </button>
  );
  return (
    <nav className="w-14 shrink-0 h-full bg-surface-1 border-r border-line flex flex-col items-center py-3 gap-1">
      <img src="/logo.svg" alt="Splitcast" className="h-7 w-7 mb-4" draggable={false} />
      {item("library", t("nav.library"), <LibraryIcon size={18} strokeWidth={1.5} />, paths.library())}
      {item("settings", t("nav.settings"), <SettingsIcon size={18} strokeWidth={1.5} />, paths.settings())}
      <div className="flex-1" />
      {MOCK && <span className="mono text-[11px] text-fg-3 pb-1">{t("nav.demo")}</span>}
    </nav>
  );
}

export function App() {
  const boot = useApp((s) => s.boot);
  const load = useApp((s) => s.load);
  const route = useRoute();
  const t = useT();
  const lang = useApp((s) => s.lang);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    applyDocLang(lang);
  }, [lang]);

  // desktop feel: no browser context menu except in text fields
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) e.preventDefault();
    };
    window.addEventListener("contextmenu", h);
    return () => window.removeEventListener("contextmenu", h);
  }, []);

  let body: JSX.Element;
  if (boot === "loading") body = <LoadingBlock />;
  else if (boot === "error")
    body = (
      <StateMessage
        title={t("boot.errorTitle")}
        body={t("boot.errorBody")}
        action={<Button onClick={load}>{t("common.retry")}</Button>}
      />
    );
  else if (route.name === "project") body = <ProjectScreen key={route.id} id={route.id} dialog={route.dialog} query={route.query} />;
  else
    body = (
      <div className="flex h-full">
        <Rail active={route.name === "settings" ? "settings" : "library"} />
        <main key={route.name} className="flex-1 min-w-0 h-full anim-screen">
          {route.name === "settings" ? <SettingsScreen /> : <Library newPaths={route.newPaths} />}
        </main>
      </div>
    );

  return (
    <div className="h-full bg-surface-0">
      {body}
      <Toasts />
    </div>
  );
}
