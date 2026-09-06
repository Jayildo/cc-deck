// Restart the cc-deck hidden server: stop whatever listens on the port, then
// relaunch the latest code on disk. Use after pulling/editing server code,
// since the hidden server has no auto-reload.
// Windows: relaunches via the autostart .vbs. macOS: kicks the launchd
// LaunchAgent if installed, else spawns run-server.sh (or `npm start`) detached.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Custom-port installs pin CC_DECK_PORT inside the launcher written by
// install-autostart; read it back so `npm run restart` finds the right listener
// without the env var being set in this shell.
function resolvePort() {
  if (process.env.CC_DECK_PORT) return process.env.CC_DECK_PORT;
  const launcher = path.join(
    os.homedir(),
    ".cc-deck",
    process.platform === "win32" ? "run-server.cmd" : "run-server.sh"
  );
  try {
    const m = fs.readFileSync(launcher, "utf8").match(/CC_DECK_PORT="?(\d+)"?/);
    if (m?.[1]) return m[1];
  } catch {
    /* no managed launcher */
  }
  return "4317";
}

if (process.platform === "win32") {
  restartWindows();
} else if (process.platform === "darwin") {
  restartDarwin();
} else {
  console.error(`This helper supports Windows and macOS only (detected: ${process.platform}).`);
  process.exit(1);
}

function restartWindows() {
  const PORT = resolvePort();

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

  // Prefer the server-only launcher (newer install:autostart writes it); the
  // Startup .vbs also runs the opener → a fresh Chrome tab on every restart.
  const serverVbs = path.join(os.homedir(), ".cc-deck", "run-server.vbs");
  const startupVbs = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "cc-deck-autostart.vbs"
  );

  function relaunch() {
    const vbs = fs.existsSync(serverVbs) ? serverVbs : fs.existsSync(startupVbs) ? startupVbs : null;
    if (vbs) {
      spawn("wscript", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      console.log(`relaunched hidden server → http://localhost:${PORT}`);
      if (vbs === startupVbs) {
        console.log("(re-run `npm run install:autostart` for a restart launcher that doesn't open a new tab)");
      }
    } else {
      console.log("autostart .vbs not found — run `npm run install:autostart` first, or `npm start`.");
    }
  }

  // Give the OS a moment to release the port before rebinding.
  if (killed) setTimeout(relaunch, 1500);
  else relaunch();
}

function restartDarwin() {
  const PORT = resolvePort();

  // -sTCP:LISTEN — plain `lsof -ti tcp:PORT` also lists client sockets on the
  // port (the dashboard's browser WS, a curl probe), so [0] could be Chrome.
  /** @type {string[]} */
  let pids = [];
  try {
    const out = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: "utf8" });
    pids = out.split("\n").map((s) => s.trim()).filter((p) => /^\d+$/.test(p));
  } catch {
    /* nothing listening (lsof exits non-zero), or lsof unavailable */
  }

  let killed = false;
  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        console.log(`stopped server (pid ${pid}) on :${PORT}`);
        killed = true;
      } catch {
        console.log(`could not stop pid ${pid}`);
      }
    }
  } else {
    console.log(`no server listening on :${PORT}`);
  }

  const home = os.homedir();
  const label = "com.ccdeck.dashboard";
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const uid = process.getuid?.();

  function relaunch() {
    if (uid !== undefined && fs.existsSync(plistPath)) {
      try {
        execSync(`launchctl kickstart -k gui/${uid}/${label}`, { stdio: "ignore" });
        console.log(`relaunched via launchd → http://localhost:${PORT}`);
        return;
      } catch {
        console.log("launchctl kickstart 실패 — detached 실행으로 대체합니다.");
      }
    }

    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const runSh = path.join(home, ".cc-deck", "run-server.sh");
    if (fs.existsSync(runSh)) {
      spawn("/bin/bash", [runSh], { detached: true, stdio: "ignore", cwd: repo }).unref();
    } else {
      spawn("npm", ["start"], {
        detached: true,
        stdio: "ignore",
        cwd: repo,
        env: { ...process.env, CC_DECK_PORT: PORT },
        shell: true,
      }).unref();
      console.log("(run-server.sh not found — run `npm run install:autostart` for a managed launcher.)");
    }
    console.log(`relaunched (detached) → http://localhost:${PORT}`);
  }

  // Give the OS a moment to release the port before rebinding.
  if (killed) setTimeout(relaunch, 1500);
  else relaunch();
}
