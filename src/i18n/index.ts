import { useCallback } from "react";
import { az, en } from "./dict";
import type { Key } from "./dict";
import { de, es, fr, it, pt, tr, pl, ru, uk, zh, ja, ko, ar, hi } from "./langs";
import { useApp } from "../store/app";
import { ApiError } from "../api/types";

export type Lang = "az" | "en" | "tr" | "ru" | "de" | "es" | "fr" | "pt" | "it" | "pl" | "uk" | "zh" | "ja" | "ko" | "ar" | "hi";
export type Params = Record<string, string | number>;
export type TFn = (key: Key, params?: Params) => string;

/** Interface languages, each named in its own language. `plural` lists the CLDR categories in the order the "a|b|c" forms are written. */
export const LANGS: { code: Lang; name: string; rtl?: boolean; plural: string[] }[] = [
  { code: "az", name: "Azərbaycanca", plural: ["other"] },
  { code: "en", name: "English", plural: ["one", "other"] },
  { code: "tr", name: "Türkçe", plural: ["one", "other"] },
  { code: "ru", name: "Русский", plural: ["one", "few", "many"] },
  { code: "uk", name: "Українська", plural: ["one", "few", "many"] },
  { code: "de", name: "Deutsch", plural: ["one", "other"] },
  { code: "fr", name: "Français", plural: ["one", "other"] },
  { code: "es", name: "Español", plural: ["one", "other"] },
  { code: "pt", name: "Português", plural: ["one", "other"] },
  { code: "it", name: "Italiano", plural: ["one", "other"] },
  { code: "pl", name: "Polski", plural: ["one", "few", "many"] },
  { code: "zh", name: "中文（简体）", plural: ["other"] },
  { code: "ja", name: "日本語", plural: ["other"] },
  { code: "ko", name: "한국어", plural: ["other"] },
  { code: "ar", name: "العربية", rtl: true, plural: ["one", "two", "few", "many", "other"] },
  { code: "hi", name: "हिन्दी", plural: ["one", "other"] },
];

const dicts: Record<Lang, Partial<Record<Key, string>>> = { az, en, tr, ru, de, es, fr, pt, it, pl, uk, zh, ja, ko, ar, hi };
const rules = new Map<Lang, Intl.PluralRules>();

function pluralForm(lang: Lang, forms: string[], n: number): string {
  let r = rules.get(lang);
  if (!r) rules.set(lang, (r = new Intl.PluralRules(lang)));
  const order = LANGS.find((l) => l.code === lang)?.plural ?? ["one", "other"];
  const i = order.indexOf(r.select(n));
  return forms[Math.min(i < 0 ? order.length - 1 : i, forms.length - 1)];
}

export function translate(lang: Lang, key: Key, params?: Params): string {
  let s: string = dicts[lang][key] ?? en[key] ?? az[key] ?? key;
  if (s.includes("|") && params && typeof params.n === "number") s = pluralForm(lang, s.split("|"), params.n);
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
  return s;
}

/** Hook: returns a translate function bound to the current language. */
export function useT(): TFn {
  const lang = useApp((s) => s.lang);
  return useCallback((key, params) => translate(lang, key, params), [lang]);
}

/** Non-hook translate for code outside React render (stores, handlers). */
export const tNow: TFn = (key, params) => translate(useApp.getState().lang, key, params);

/** Plain-language text for any thrown error. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network") return tNow("err.network");
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return tNow("common.unknown");
}

/** "What failed: why" */
export function errWith(what: string, e: unknown): string {
  return `${what}. ${errText(e)}`;
}
