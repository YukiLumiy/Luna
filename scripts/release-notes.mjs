// Prints the patch notes of one version (from src/patchNotes.json), for the GitHub release body:
//
//   node scripts/release-notes.mjs v0.1.3
//
// Fails if that version has no notes, so a release can't go out without them.
import fs from "node:fs";

const v = String(process.argv[2] ?? "").replace(/^v/i, "");
const notes = JSON.parse(fs.readFileSync("src/patchNotes.json", "utf8"));
if (!notes[v]?.trim()) {
  console.error(`src/patchNotes.json has no notes for ${v}. Add them before releasing.`);
  process.exit(1);
}
process.stdout.write(notes[v].trim() + "\n");
