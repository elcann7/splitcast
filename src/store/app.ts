import { create } from "zustand";
import { api } from "../api";
import type { Settings, SystemInfo } from "../api";
import { LANGS } from "../i18n";
import type { Lang } from "../i18n";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

interface AppState {
  lang: Lang;
  settings: Settings | null;
  system: SystemInfo | null;
  boot: "loading" | "ready" | "error";
  toasts: Toast[];
  load: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export function applyDocLang(lang: Lang) {
  const el = document.documentElement;
  el.lang = lang;
  el.dir = LANGS.find((l) => l.code === lang)?.rtl ? "rtl" : "ltr";
}

export const useApp = create<AppState>((set, get) => ({
  lang: "az",
  settings: null,
  system: null,
  boot: "loading",
  toasts: [],

  async load() {
    set({ boot: "loading" });
    try {
      const [settings, system] = await Promise.all([api.getSettings(), api.system()]);
      set({ settings, system, lang: settings.language, boot: "ready" });
    } catch {
      set({ boot: "error" });
    }
  },

  async refreshSystem() {
    try {
      set({ system: await api.system() });
    } catch {
      /* keep the previous value */
    }
  },

  async saveSettings(patch) {
    const prev = get().settings;
    if (!prev) return;
    const next = { ...prev, ...patch };
    set({ settings: next, lang: next.language });
    try {
      const saved = await api.putSettings(next);
      set({ settings: saved, lang: saved.language });
    } catch (e) {
      set({ settings: prev, lang: prev.language });
      throw e;
    }
  },

  toast(kind, text) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

