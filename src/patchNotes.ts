import notes from "./patchNotes.json";
import { isNewer } from "./updater";

/** Patch notes live in patchNotes.json, inside the app itself (and become the GitHub release text). */
const NOTES = notes as Record<string, string>;

export interface PatchEntry {
  version: string;
  notes: string;
}

/** Every version's notes, newest first. */
export function allPatchNotes(): PatchEntry[] {
  return Object.entries(NOTES)
    .map(([version, text]) => ({ version, notes: text }))
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
}

export function patchNotesFor(version: string): PatchEntry | null {
  const text = NOTES[version.replace(/^v/i, "")];
  return text?.trim() ? { version, notes: text } : null;
}
