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
