// Remove the cc-deck Windows login autostart entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
