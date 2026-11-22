export const THEMES = ["dark", "light"] as const;
export type ThemeId = (typeof THEMES)[number];

export const isTheme = (v: unknown): v is ThemeId => typeof v === "string" && (THEMES as readonly string[]).includes(v);

/**
 * Settings saved by older builds may name a theme that no longer exists. The
 * two Liquid Glass themes are gone; they map to the plain theme closest to
 * them (the dark one to dark, the light one to light).
 */
export function normalizeTheme(id: unknown): ThemeId {
  if (isTheme(id)) return id;
  return id === "glass" ? "light" : "dark";
}

/** Sets the theme on <html>. Unknown or retired values fall back as described above. */
export function applyTheme(id: string): ThemeId {
  const theme = normalizeTheme(id);
  document.documentElement.setAttribute("data-theme", theme);
  return theme;
}
