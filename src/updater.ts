import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "error"; message: string };

// One shared state, so the banner on the home screen and the card in Settings agree.
let state: UpdateState = { kind: "idle" };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

const AUTO_KEY = "luna.autoUpdate";
export const autoUpdateEnabled = () => localStorage.getItem(AUTO_KEY) !== "off";
export const setAutoUpdate = (on: boolean) => localStorage.setItem(AUTO_KEY, on ? "on" : "off");

/** True if version `a` is newer than `b` (compares the numeric parts: 0.1.10 > 0.1.9). */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/i, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Asks GitHub (through the updater endpoint) whether a newer release exists. The endpoint is
 * `releases/latest`, so even if several releases were skipped the answer is the newest one;
 * anything that isn't actually newer than the running version is ignored.
 * `quiet`: a startup check — a failure (offline, no release yet) isn't shown as an error.
 */
export async function checkForUpdate(quiet = false) {
  if (state.kind === "checking" || state.kind === "downloading") return;
  set({ kind: "checking" });
  try {
    const update = await check();
    const current = await getVersion().catch(() => "0.0.0");
    if (update && isNewer(update.version, current)) {
      pending = update;
      set({ kind: "available", version: update.version, notes: update.body ?? null });
    } else {
      pending = null;
      set({ kind: "none" });
    }
  } catch (err) {
    set(quiet ? { kind: "none" } : { kind: "error", message: String(err) });
  }
}

const NOTES_KEY = "luna.pendingNotes";
const SEEN_KEY = "luna.lastVersion";

/**
 * The patch notes to show once, on the first start after an update. They are saved just
 * before installing (the updater hands them over with the update), and shown only if the
 * running version is the one they were saved for. A fresh install, or an update that
 * brought no notes, shows nothing. Every version is "seen" exactly once.
 */
export function takePatchNotes(current: string): { version: string; notes: string } | null {
  try {
    const last = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, current);
    if (last === null || last === current) return null;
    const saved = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "null") as { version?: string; notes?: string } | null;
    if (saved?.version === current && saved.notes?.trim()) {
      localStorage.removeItem(NOTES_KEY);
      return { version: current, notes: saved.notes };
    }
  } catch {
    // storage unavailable or corrupt: just skip the notes
  }
  return null;
}

/** Downloads and runs the installer; Luna closes and the new version starts. */
export async function installUpdate() {
  if (!pending) return;
  const version = pending.version;
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify({ version, notes: pending.body ?? "" }));
  } catch {
    // no notes after the update, then
  }
  let total = 0;
  let received = 0;
  set({ kind: "downloading", version, percent: null });
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        set({ kind: "downloading", version, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
      }
    });
    await relaunch();
  } catch (err) {
    set({ kind: "error", message: String(err) });
  }
}
