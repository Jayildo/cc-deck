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

// ── Determine the original command ───────────────────────────────────────────
let originalCmd = null;
let source = null;

// Prefer the dedicated save (just the command string).
try {
  const saved = JSON.parse(fs.readFileSync(ORIGINAL_JSON, "utf8"));
  if (typeof saved?.command === "string") {
    originalCmd = saved.command;
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

const before = settings?.statusLine?.command ?? "(none)";

// ── Restore ───────────────────────────────────────────────────────────────────
if (!settings.statusLine) settings.statusLine = {};
if (originalCmd === "") {
  // Original had no command — remove the key entirely.
  delete settings.statusLine.command;
} else {
  settings.statusLine.command = originalCmd;
}
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");

console.log("Done.");
console.log(`  Restored from: ${source}`);
console.log(`  Before: ${before}`);
console.log(`  After : ${originalCmd || "(removed)"}`);
console.log(`\nThe tee wrapper and feed file are kept in ${CC_DECK_DIR} — delete manually if desired.`);
