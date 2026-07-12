// Install cc-deck as a hidden, auto-starting background server on login.
// Windows: drops a .vbs into the user's Startup folder that launches a .cmd
// (hidden) which runs the server with a STABLE node (not the ephemeral fnm
// multishell path), then opens the dashboard in Chrome.
// macOS: installs a launchd LaunchAgent (~/Library/LaunchAgents) that runs the
// server on login via a stable node, then opens the dashboard in Chrome (or the
// default browser). Reversible via uninstall-autostart.mjs on both platforms.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

if (process.platform === "win32") {
  installWindows();
} else if (process.platform === "darwin") {
  installDarwin();
} else {
  console.error(`This installer supports Windows and macOS only (detected: ${process.platform}).`);
  process.exit(1);
}

function installWindows() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // The server serves web/dist statically in production (isProd → no Vite dev
  // server); installing autostart against an unbuilt repo silently ships a
  // working server behind a 404'ing dashboard.
  if (!fs.existsSync(path.join(repo, "web", "dist", "index.html"))) {
    console.error("web/dist가 없습니다 — 먼저 `npm run build`를 실행하세요.");
    process.exit(1);
  }

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

  const PORT = process.env.CC_DECK_PORT ?? "4317";
  const URL = `http://127.0.0.1:${PORT}`;

  function resolveChrome() {
    const cands = [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    for (const c of cands) if (c && fs.existsSync(c)) return c;
    return "chrome"; // fall back to PATH / App Paths
  }
  const chromeExe = resolveChrome();

  const logPath = path.join(deckDir, "server.log");
  const cmdPath = path.join(deckDir, "run-server.cmd");
  const cmd =
    [
      "@echo off",
      `cd /d "${repo}"`,
      "set NODE_ENV=production",
      `set CC_DECK_PORT=${PORT}`,
      `"${nodeExe}" --import tsx server\\index.ts > "${logPath}" 2>&1`,
    ].join("\r\n") + "\r\n";
  fs.writeFileSync(cmdPath, cmd, "utf8");

  // Opener: wait until the server answers, then open it in Chrome.
  const openCmdPath = path.join(deckDir, "open-dashboard.cmd");
  const openCmd =
    [
      "@echo off",
      `set "URL=${URL}"`,
      "set /a n=0",
      ":wait",
      'curl -s -o nul --max-time 2 "%URL%/api/health" && goto open',
      "set /a n+=1",
      "if %n% geq 30 goto open",
      "ping -n 2 127.0.0.1 >nul",
      "goto wait",
      ":open",
      `start "" "${chromeExe}" "%URL%"`,
    ].join("\r\n") + "\r\n";
  fs.writeFileSync(openCmdPath, openCmd, "utf8");

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
  const vbs =
    `Set sh = CreateObject("WScript.Shell")\r\n` +
    `sh.Run """${cmdPath}""", 0, False\r\n` + // start server (hidden)
    `sh.Run """${openCmdPath}""", 0, False\r\n`; // wait + open Chrome (hidden launcher, visible browser)
  fs.writeFileSync(vbsPath, vbs, "utf8");

  console.log("✅ cc-deck autostart installed.\n");
  console.log("   launcher : " + cmdPath);
  console.log("   opener   : " + openCmdPath);
  console.log("   startup  : " + vbsPath);
  console.log("   node     : " + nodeExe);
  console.log("   chrome   : " + chromeExe);
  console.log("   log      : " + logPath + "\n");
  console.log(`On next login: server starts hidden AND Chrome opens ${URL} automatically.`);
  console.log(`Open the dashboard now (server already running):  "${openCmdPath}"`);
  console.log("Remove:  npm run uninstall:autostart");
}

function installDarwin() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // Mirrors the Windows guard: production serves the built web/dist statically.
  if (!fs.existsSync(path.join(repo, "web", "dist", "index.html"))) {
    console.error("web/dist가 없습니다 — 먼저 `npm run build`를 실행하세요.");
    process.exit(1);
  }

  const home = os.homedir();
  const deckDir = path.join(home, ".cc-deck");
  fs.mkdirSync(deckDir, { recursive: true });

  // Prefer a stable Homebrew/system node over a version-manager shim path
  // (nvm/fnm/volta/asdf), which can move or vanish between shell sessions and
  // break autostart after reboot — mirrors the Windows "ephemeral fnm" guard.
  const stableCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
  const nodeExe = stableCandidates.find((c) => fs.existsSync(c)) ?? process.execPath;
  if (/\.(nvm|fnm|volta|asdf)\//i.test(nodeExe) || /fnm_multishells/i.test(nodeExe)) {
    console.warn(
      "⚠ Only a version-manager node path was found; autostart may break after reboot.\n" +
        "  Install Node from nodejs.org or `brew install node`, or edit the node path in:\n  " +
        path.join(deckDir, "run-server.sh")
    );
  }

  const PORT = process.env.CC_DECK_PORT ?? "4317";
  const URL = `http://127.0.0.1:${PORT}`;

  const logPath = path.join(deckDir, "server.log");
  const runShPath = path.join(deckDir, "run-server.sh");
  const openShPath = path.join(deckDir, "open-dashboard.sh");

  const runSh = `#!/bin/bash
# cc-deck autostart launcher — managed by scripts/install-autostart.mjs. DO NOT EDIT by hand.
cd "${repo}" || exit 1
export NODE_ENV=production
export CC_DECK_PORT="${PORT}"
# Kick off the "wait for health, then open browser" helper in the background; it
# exits on its own once it opens the dashboard (or times out). exec below then
# replaces this shell with node, so launchd tracks the server directly.
"${openShPath}" &
disown
exec "${nodeExe}" --import tsx server/index.ts >> "${logPath}" 2>&1
`;
  fs.writeFileSync(runShPath, runSh, { encoding: "utf8", mode: 0o755 });

  const openSh = `#!/bin/bash
# Waits for the server to answer, then opens the dashboard — managed by scripts/install-autostart.mjs.
URL="${URL}"
n=0
while [ "$n" -lt 30 ]; do
  if curl -s -o /dev/null --max-time 2 "$URL/api/health"; then break; fi
  n=$((n + 1))
  sleep 2
done
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$URL"
else
  open "$URL"
fi
`;
  fs.writeFileSync(openShPath, openSh, { encoding: "utf8", mode: 0o755 });

  const label = "com.ccdeck.dashboard";
  const agentsDir = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const plistPath = path.join(agentsDir, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${runShPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, "utf8");

  const uid = process.getuid?.();
  if (uid !== undefined) {
    const domain = `gui/${uid}`;
    // Idempotent: bootout any previously-loaded copy first (fine if none is loaded).
    try {
      execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "ignore" });
    } catch {
      /* wasn't loaded — fine */
    }
    try {
      execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
    } catch (err) {
      console.error("launchctl bootstrap 실패:", err instanceof Error ? err.message : err);
      console.error(`plist는 작성됨 — 수동으로 로드: launchctl bootstrap ${domain} ${plistPath}`);
      process.exit(1);
    }
  } else {
    console.warn("⚠ Could not determine uid — plist written but not loaded. Run manually:");
    console.warn(`  launchctl bootstrap gui/$(id -u) ${plistPath}`);
  }

  console.log("✅ cc-deck autostart installed (launchd).\n");
  console.log("   launcher : " + runShPath);
  console.log("   opener   : " + openShPath);
  console.log("   plist    : " + plistPath);
  console.log("   node     : " + nodeExe);
  console.log("   log      : " + logPath + "\n");
  console.log(`On next login: server starts AND your browser opens ${URL} automatically.`);
  console.log(`Start it now without waiting for login:  launchctl kickstart -k gui/$(id -u)/${label}`);
  console.log("Remove:  npm run uninstall:autostart");
}
