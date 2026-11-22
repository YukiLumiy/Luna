/** The selectable colour palettes. The colours themselves live in styles/palettes.css (generated); this list only
 *  feeds the picker (name and swatch). Each palette has a dark and a light form. */
export const PALETTES = [
  {id: "indigo", label: "A Midnight Indigo", dark: "#0f1226", accent: "#a9b6ff", light: "#f3f4fa", lightAccent: "#5b6cf0"},
  {id: "rose", label: "B Dusty Rose", dark: "#1a1219", accent: "#d9a0b9", light: "#f6f0f3", lightAccent: "#b2587c"},
  {id: "teal", label: "C Deep Teal", dark: "#0b1a1c", accent: "#7fd6c8", light: "#eff6f5", lightAccent: "#2f8f85"},
  {id: "wine", label: "D Wine & Champagne", dark: "#1b0f13", accent: "#e3b88c", light: "#f8f2ec", lightAccent: "#b0763f"},
  {id: "sakura", label: "E Sakura", dark: "#1c0d17", accent: "#f59cc4", light: "#fdf1f6", lightAccent: "#e8588f"},
  {id: "violet", label: "F Violet Dusk", dark: "#150f24", accent: "#c0a6ff", light: "#f5f1fb", lightAccent: "#7c5bd6"},
  {id: "crimson", label: "G Crimson", dark: "#1a0d0e", accent: "#ff8a80", light: "#fbf1f0", lightAccent: "#cf3d3d"},
  {id: "graphite", label: "H Graphite", dark: "#13151a", accent: "#b4bccf", light: "#f2f3f5", lightAccent: "#5d6475"},
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];
export const DEFAULT_PALETTE: PaletteId = "indigo";

const KEY = "luna.palette";
export const isPalette = (v: unknown): v is PaletteId => PALETTES.some((p) => p.id === v);

export function savedPalette(): PaletteId {
  try {
    const v = localStorage.getItem(KEY);
    if (isPalette(v)) return v;
  } catch {
    // storage unavailable: fall back to the default
  }
  return DEFAULT_PALETTE;
}

/** Sets the palette on <html>, and remembers it unless `remember` is false. */
export function applyPalette(id: PaletteId, remember = true) {
  document.documentElement.setAttribute("data-palette", id);
  if (!remember) return;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // applied for this session only
  }
}

applyPalette(savedPalette(), false);
