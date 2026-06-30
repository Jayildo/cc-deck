// Install cc-deck as a hidden, auto-starting background server on Windows login.
// Non-admin: drops a .vbs into the user's Startup folder that launches a .cmd
// (hidden) which runs the server with a STABLE node (not the ephemeral fnm
// multishell path). Reversible via uninstall-autostart.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("This installer targets Windows only.");
  process.exit(1);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const deckDir = path.join(home, ".cc-deck");
fs.mkdirSync(deckDir, { recursive: true });

// Prefer a stable system node; fall back to the current one (warn if ephemeral).
const stableNode = "C:\\Program Files\\nodejs\\node.exe";
const nodeExe = fs.existsSync(stableNode) ? stableNode : process.execPath;
if (/fnm_multishells/i.test(nodeExe)) {
  console.warn(
    "⚠ Only an ephemeral node path was found; autostart may break after reboot.\n" +
      "  Install Node from nodejs.org, or edit the node path in:\n  " +
      path.join(deckDir, "run-server.cmd")
  );
}

const logPath = path.join(deckDir, "server.log");
const cmdPath = path.join(deckDir, "run-server.cmd");
const cmd =
  [
    "@echo off",
    `cd /d "${repo}"`,
    "set NODE_ENV=production",
    `"${nodeExe}" --import tsx server\\index.ts > "${logPath}" 2>&1`,
  ].join("\r\n") + "\r\n";
fs.writeFileSync(cmdPath, cmd, "utf8");

const startupDir = path.join(
  process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup"
);
fs.mkdirSync(startupDir, { recursive: true });
const vbsPath = path.join(startupDir, "cc-deck-autostart.vbs");
fs.writeFileSync(vbsPath, `CreateObject("WScript.Shell").Run """${cmdPath}""", 0, False\r\n`, "utf8");

console.log("✅ cc-deck autostart installed.\n");
console.log("   launcher : " + cmdPath);
console.log("   startup  : " + vbsPath);
console.log("   node     : " + nodeExe);
console.log("   log      : " + logPath + "\n");
console.log("On next login it starts hidden → open http://localhost:4317");
console.log('Start it now (no reboot):  wscript "' + vbsPath + '"');
console.log("   (stop any manual `npm start` first so port 4317 is free)\n");
console.log("Remove:  npm run uninstall:autostart");
