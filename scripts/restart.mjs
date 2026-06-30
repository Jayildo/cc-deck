// Restart the cc-deck hidden server: stop whatever listens on the port, then
// relaunch the autostart .vbs (which runs the latest code on disk). Use after
// pulling/editing server code, since the hidden server has no auto-reload.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.CC_DECK_PORT ?? "4317";

let pid = null;
try {
  const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
  for (const line of out.split("\n")) {
    if (line.includes("LISTENING") && line.includes(`:${PORT}`)) {
      const cols = line.trim().split(/\s+/);
      pid = cols[cols.length - 1];
      break;
    }
  }
} catch {
  /* netstat failed */
}

let killed = false;
if (pid && /^\d+$/.test(pid)) {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    console.log(`stopped server (pid ${pid}) on :${PORT}`);
    killed = true;
  } catch {
    console.log(`could not stop pid ${pid}`);
  }
} else {
  console.log(`no server listening on :${PORT}`);
}

const vbs = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup",
  "cc-deck-autostart.vbs"
);

function relaunch() {
  if (fs.existsSync(vbs)) {
    spawn("wscript", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log(`relaunched hidden server → http://localhost:${PORT}`);
  } else {
    console.log("autostart .vbs not found — run `npm run install:autostart` first, or `npm start`.");
  }
}

// Give the OS a moment to release the port before rebinding.
if (killed) setTimeout(relaunch, 1500);
else relaunch();
