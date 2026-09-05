// Put TarkovMap's guarded portable stub in place of electron-builder's template.
//
// ⚠️ WHY A PATCH STEP. `NsisTarget` reads `templates/nsis/portable.nsi` from
// app-builder-lib unconditionally — `nsis.script` only applies to the installer
// — so the only way to ship a different launcher stub is to overwrite the
// template before `electron-builder` runs. `npm install` restores the stock
// file, which is why this runs inside `app:build` every time rather than once.
// See build/portable.nsi for what the guard prevents (a second launch wiping
// the running instance's bundled ffmpeg and speech bindings).
//
// Verified, not assumed: after copying, the template is re-read and must carry
// the guard's marker, or the build stops here instead of shipping the stock
// stub under our name.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ours = resolve(ROOT, "build", "portable.nsi");
const theirs = resolve(ROOT, "node_modules", "app-builder-lib", "templates", "nsis", "portable.nsi");
export const GUARD_MARKER = "goodh_running:";

if (!existsSync(theirs)) {
  console.error(`patch-portable-nsi: ${theirs} not found — is app-builder-lib installed?`);
  process.exit(1);
}
const before = readFileSync(theirs, "utf8");
if (!before.includes(GUARD_MARKER)) {
  copyFileSync(ours, theirs);
}
const after = readFileSync(theirs, "utf8");
if (!after.includes(GUARD_MARKER) || !after.includes("extractEmbeddedAppPackage")) {
  console.error("patch-portable-nsi: the template does not carry the guard after patching — refusing to build.");
  process.exit(1);
}
console.log(`patch-portable-nsi: portable stub ${before === after ? "already" : "now"} guarded against a second launch.`);
