import { useSyncExternalStore } from "react";
import { en } from "./locales/en";
import { ko } from "./locales/ko";

export type Lang = "en" | "ko";
export type Key = keyof typeof en;

const dict: Record<Lang, Record<Key, string>> = { en, ko };
const STORE_KEY = "luna.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === "en" || saved === "ko") return saved;
  } catch {
    // storage unavailable: fall through to the system language
  }
  return navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

let current: Lang = detect();
const listeners = new Set<() => void>();
document.documentElement.lang = current;

export const getLang = (): Lang => current;

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    // not persisted, still applied for this session
  }
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn());
}

/** Looks a string up in the current language; `{name}` placeholders are filled from `vars`. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  let text = dict[current][key] ?? dict.en[key] ?? key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  return text;
}

/** For labels stored as data: "@preset.sky.label" is translated, anything else is shown as is. */
export const tx = (label: string): string => (label.startsWith("@") ? t(label.slice(1) as Key) : label);

/** Use in components so they re-render when the language changes. */
export function useT() {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getLang,
  );
  return t;
}
