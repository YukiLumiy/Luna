// Bumps the version everywhere, commits, and tags it:
//
//   npm run release -- 0.1.4
//
// Add the version's notes to src/patchNotes.json first (they are shown in the app, once after the
// update, and become the GitHub release's text). Then push the commit and the tag; GitHub Actions
// builds, signs and publishes it.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { setVersion } from "./set-version.mjs";

const arg = process.argv[2];
let version;
try {
  version = String(arg ?? "").replace(/^v/i, "");
  const notes = JSON.parse(fs.readFileSync("src/patchNotes.json", "utf8"));
  if (!notes[version]?.trim()) throw new Error(`src/patchNotes.json has no notes for ${version} — add them first.`);
  setVersion(version);
} catch (e) {
  console.error(String(e.message ?? e));
  console.error("Usage: npm run release -- 0.1.4");
  process.exit(1);
}
// Commit whatever changed (the version files, and the notes if they are new). If the version was
// already set, there may be nothing left to commit — the tag is still made.
execSync("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src/patchNotes.json", { stdio: "inherit" });
try {
  execSync(`git commit -m "v${version}"`, { stdio: "inherit" });
} catch {
  console.log("(nothing new to commit)");
}
execSync(`git tag v${version}`, { stdio: "inherit" });
console.log(`\nTagged v${version}. Publish it with:\n  git push origin HEAD --tags`);
