// Remove the cc-deck login autostart entry.
// Windows: deletes the Startup-folder .vbs. macOS: unloads + deletes the
// launchd LaunchAgent plist. Mirrors install-autostart.mjs's platform split.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform === "win32") {
  uninstallWindows();
} else if (process.platform === "darwin") {
  uninstallDarwin();
} else {
  console.error(`This uninstaller supports Windows and macOS only (detected: ${process.platform}).`);
  process.exit(1);
}

function uninstallWindows() {
  const home = os.homedir();
  const startupDir = path.join(
    process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  const vbsPath = path.join(startupDir, "cc-deck-autostart.vbs");

  let removed = false;
  try {
    fs.unlinkSync(vbsPath);
    removed = true;
  } catch {
    /* not present */
  }

  console.log(removed ? "✅ Autostart removed:\n   " + vbsPath : "ℹ No autostart entry at\n   " + vbsPath);
  console.log("\n(The launcher " + path.join(home, ".cc-deck", "run-server.cmd") + " is left in place;");
  console.log(" a running hidden server keeps running until reboot or you kill its node process.)");
}

function uninstallDarwin() {
  const home = os.homedir();
  const label = "com.ccdeck.dashboard";
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);

  const uid = process.getuid?.();
  let unloaded = false;
  if (uid !== undefined && fs.existsSync(plistPath)) {
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
      unloaded = true;
    } catch {
      /* wasn't loaded — fine */
    }
  }

  let removed = false;
  try {
    fs.unlinkSync(plistPath);
    removed = true;
  } catch {
    /* not present */
  }

  console.log(removed ? "✅ Autostart removed:\n   " + plistPath : "ℹ No autostart entry at\n   " + plistPath);
  if (unloaded) console.log("   (launchd job unloaded)");
  console.log("\n(The launcher " + path.join(home, ".cc-deck", "run-server.sh") + " is left in place;");
  console.log(" a running server keeps running until you stop it or log out.)");
}
