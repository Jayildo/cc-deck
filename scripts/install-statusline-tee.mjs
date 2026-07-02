#!/usr/bin/env node
// install-statusline-tee.mjs
// NON-DESTRUCTIVE opt-in: wires a tee into ~/.claude/settings.json statusLine.command
// so cc-deck can read live usage data without polling the OAuth endpoint on every cycle.
// Run: node scripts/install-statusline-tee.mjs   (or via npm script)

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
const FEED_JSONL = path.join(CC_DECK_DIR, "statusline-feed.jsonl");
const FEED_TMP = path.join(CC_DECK_DIR, ".feed.tmp");

// Convert Windows path to Git-Bash /c/... form for use in shell commands.
function toGitBash(p) {
  return p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll("\\", "/");
}

const TEE_SH_GB = toGitBash(TEE_SH);
const FEED_JSONL_GB = toGitBash(FEED_JSONL);
const FEED_TMP_GB = toGitBash(FEED_TMP);
const TEE_CMD = `bash "${TEE_SH_GB}"`;

// ── Read settings ─────────────────────────────────────────────────────────────
let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
} catch (err) {
  console.error(`ERROR: Cannot read ${SETTINGS_PATH}: ${err.message}`);
  process.exit(1);
}

const current = settings?.statusLine?.command ?? "";
const statusLineExisted = !!settings.statusLine; // did the user have ANY statusLine config?

if (current === TEE_CMD) {
  console.log("Already installed — statusLine.command already points to the tee.");
  console.log(`  ${TEE_CMD}`);
  process.exit(0);
}

// ── Ensure ~/.cc-deck exists ──────────────────────────────────────────────────
fs.mkdirSync(CC_DECK_DIR, { recursive: true });

// ── Back up settings.json and save original command ───────────────────────────
fs.writeFileSync(SETTINGS_BAK, JSON.stringify(settings, null, 2), "utf8");
fs.writeFileSync(
  ORIGINAL_JSON,
  JSON.stringify(
    { command: current, existed: statusLineExisted, savedAt: new Date().toISOString() },
    null,
    2
  ),
  "utf8"
);
console.log(`Backed up settings.json → ${SETTINGS_BAK}`);
console.log(`Saved original statusLine.command → ${ORIGINAL_JSON}`);

// ── Write tee wrapper ─────────────────────────────────────────────────────────
// The wrapper:
//   1. Reads stdin once.
//   2. Appends to the feed JSONL (one JSON object per line).
//   3. Trims feed to last 200 lines in-place.
//   4. Pipes the original input to the original command, preserving its output exactly.
// `cat` would echo the raw JSON payload straight to the statusline when there is
// no original command to fall back to; `true` reads/discards stdin silently.
const originalCmd = current || "true";
const teeSh = `#!/usr/bin/env bash
# statusline-tee.sh — managed by cc-deck install-statusline-tee.mjs
# DO NOT EDIT by hand; run uninstall-statusline-tee.mjs to restore original.

input=$(cat)
printf '%s\\n' "$input" >> "${FEED_JSONL_GB}"
tail -n 200 "${FEED_JSONL_GB}" > "${FEED_TMP_GB}" && mv "${FEED_TMP_GB}" "${FEED_JSONL_GB}"
printf '%s' "$input" | ${originalCmd}
`;

fs.writeFileSync(TEE_SH, teeSh, { encoding: "utf8", mode: 0o755 });
console.log(`Written tee wrapper → ${TEE_SH}`);

// ── Patch settings.json ───────────────────────────────────────────────────────
if (!settings.statusLine) settings.statusLine = {};
settings.statusLine.type = "command"; // required — Claude Code ignores statusLine without it
settings.statusLine.command = TEE_CMD;
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");

console.log("\nDone.");
console.log(`  Before: ${current || "(none)"}`);
console.log(`  After : ${TEE_CMD}`);
console.log(`\nLive usage data will be appended to:`);
console.log(`  ${FEED_JSONL}`);
console.log(`\nTo undo: node scripts/uninstall-statusline-tee.mjs`);
