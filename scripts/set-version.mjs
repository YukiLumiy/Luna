// Writes one version into every file that carries it, so the installer's file name, the app's
// own version display and the updater all agree:
//
//   node scripts/set-version.mjs 0.1.3        (a leading "v" is fine: v0.1.3)
//
// GitHub Actions runs this with the tag name before building, so a release is always built as
// the version of its tag, whatever the files in the commit say. `npm run release` runs it too.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

export function setVersion(input) {
  const v = String(input ?? "").replace(/^v/i, "");
  if (!VERSION_RE.test(v)) throw new Error(`Not a version like 1.2.3: "${input}"`);
  const files = {
    "package.json": (t) => t.replace(/("version":\s*")[^"]+/, `$1${v}`),
    "src-tauri/tauri.conf.json": (t) => t.replace(/("version":\s*")[^"]+/, `$1${v}`),
    "src-tauri/Cargo.toml": (t) => t.replace(/^version\s*=\s*"[^"]+"/m, `version = "${v}"`),
    // the lock file records the app's own version too; cargo rewrites it otherwise
    "src-tauri/Cargo.lock": (t) => t.replace(/(name = "luna"\r?\nversion = ")[^"]+/, `$1${v}`),
  };
  const changed = [];
  for (const [file, edit] of Object.entries(files)) {
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = edit(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(file);
    }
  }
  return { version: v, changed, files: Object.keys(files).filter((f) => fs.existsSync(f)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { version, changed } = setVersion(process.argv[2]);
    console.log(`Version ${version}: ${changed.length ? "updated " + changed.join(", ") : "already set everywhere"}`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
