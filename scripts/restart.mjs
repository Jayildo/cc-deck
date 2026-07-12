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

if (process.platform === "win32") {
  restartWindows();
} else if (process.platform === "darwin") {
  restartDarwin();
} else {
  console.error(`This helper supports Windows and macOS only (detected: ${process.platform}).`);
  process.exit(1);
}

function restartWindows() {
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
}

function restartDarwin() {
  const PORT = process.env.CC_DECK_PORT ?? "4317";

  let pid = null;
  try {
    const out = execSync(`lsof -ti tcp:${PORT}`, { encoding: "utf8" }).trim();
    if (out) pid = out.split("\n")[0]?.trim() ?? null;
  } catch {
    /* nothing listening, or lsof unavailable */
  }

  let killed = false;
  if (pid && /^\d+$/.test(pid)) {
    try {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      console.log(`stopped server (pid ${pid}) on :${PORT}`);
      killed = true;
    } catch {
      console.log(`could not stop pid ${pid}`);
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
