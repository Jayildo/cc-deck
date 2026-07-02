#!/usr/bin/env node
// uninstall-statusline-tee.mjs
// Restore the original statusLine.command that install-statusline-tee.mjs replaced.
// Run: node scripts/uninstall-statusline-tee.mjs   (or via npm script)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const CC_DECK_DIR = path.join(HOME, ".cc-deck");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const SETTINGS_BAK = path.join(CC_DECK_DIR, "settings.json.bak");
const ORIGINAL_JSON = path.join(CC_DECK_DIR, "statusline-original.json");
const TEE_SH = path.join(CC_DECK_DIR, "statusline-tee.sh");

// Convert Windows path to Git-Bash /c/... form — mirrors install-statusline-tee.mjs
// so TEE_CMD here is byte-identical to what install wrote into settings.json.
function toGitBash(p) {
  return p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll("\\", "/");
}
const TEE_CMD = `bash "${toGitBash(TEE_SH)}"`;

// ── Determine the original command ───────────────────────────────────────────
let originalCmd = null;
let existed = true; // did the user have ANY statusLine config before install?
let source = null;

// Prefer the dedicated save (command string + whether statusLine existed before install).
try {
  const saved = JSON.parse(fs.readFileSync(ORIGINAL_JSON, "utf8"));
  if (typeof saved?.command === "string") {
    originalCmd = saved.command;
    existed = saved.existed ?? true; // older backups predate this field — assume it existed
    source = ORIGINAL_JSON;
  }
} catch {
  // fall through to backup
}

// Fall back to the full settings backup.
if (originalCmd === null) {
  try {
    const bak = JSON.parse(fs.readFileSync(SETTINGS_BAK, "utf8"));
    if (typeof bak?.statusLine?.command === "string") {
      originalCmd = bak.statusLine.command;
      existed = true; // bak.statusLine.command existing implies statusLine existed
      source = SETTINGS_BAK;
    }
  } catch {
    // nothing
  }
}

if (originalCmd === null) {
  console.error("ERROR: No backup found. Neither of these exist or contain a command:");
  console.error(`  ${ORIGINAL_JSON}`);
  console.error(`  ${SETTINGS_BAK}`);
  console.error("Restore manually by editing ~/.claude/settings.json statusLine.command.");
  process.exit(1);
}

// ── Read current settings ─────────────────────────────────────────────────────
let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
} catch (err) {
  console.error(`ERROR: Cannot read ${SETTINGS_PATH}: ${err.message}`);
  process.exit(1);
}

const currentCmd = settings?.statusLine?.command;
const before = currentCmd ?? "(none)";

// Someone may have reconfigured statusLine.command since install (manually, or by
// re-running install-statusline-tee against a different tee path) — don't clobber
// whatever they have now with a stale backup.
if (currentCmd !== TEE_CMD) {
  console.log("cc-deck tee가 아님 — 복원 생략");
  console.log(`  현재 statusLine.command: ${before}`);
  console.log(`  예상(cc-deck tee): ${TEE_CMD}`);
  process.exit(0);
}

// ── Restore ───────────────────────────────────────────────────────────────────
if (!existed) {
  // statusLine didn't exist before install — remove it entirely instead of
  // leaving a stray { command: "" } (or worse, no "type") object behind.
  delete settings.statusLine;
} else if (originalCmd === "") {
  // Original had no command — remove the key entirely.
  delete settings.statusLine.command;
} else {
  settings.statusLine.command = originalCmd;
}
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");

console.log("Done.");
console.log(`  Restored from: ${source}`);
console.log(`  Before: ${before}`);
console.log(`  After : ${existed ? originalCmd || "(removed)" : "(statusLine removed — it didn't exist before install)"}`);
console.log(`\nThe tee wrapper and feed file are kept in ${CC_DECK_DIR} — delete manually if desired.`);

// ── Retire the backups so a re-run doesn't reapply stale data ─────────────────
for (const f of [ORIGINAL_JSON, SETTINGS_BAK]) {
  try {
    fs.renameSync(f, `${f}.restored`);
  } catch {
    /* one of the two may not exist (e.g. install failed partway) — ignore */
  }
}
