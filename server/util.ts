import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.js";

/**
 * Encode a working directory the way Claude Code names its transcript folder
 * under ~/.claude/projects: every non-alphanumeric character becomes "-".
 *   C:\Users\JWG          -> C--Users-JWG
 *   C:\project\ad_anal3    -> C--project-ad-anal3
 * Verified against the real ~/.claude/projects on this machine.
 */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Locate a session's transcript JSONL. The session id is a UUID and unique, so
 * we prefer a direct hit on the slug dir and fall back to scanning every
 * project dir for "<sessionId>.jsonl" — robust against slug-encoding edge cases.
 */
export function findTranscriptPath(sessionId: string, cwd?: string): string | null {
  if (cwd) {
    const direct = path.join(config.paths.projectsDir, slugForCwd(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(config.paths.projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const p = path.join(config.paths.projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function readJsonSafe<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readJsonSafeSync<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Known-project labels keyed by cwd basename (mirrors the user's statusline). */
const PROJECT_LABELS: Record<string, string> = {
  "socp-erp": "📦 SOCP-ERP",
  "type-d-project": "🌏 TYPE-D",
  ad_anal3: "📊 AD-ANAL3",
  anal4: "📈 ANAL4",
  papa_01_record: "🎙️ PAPA",
  "coupang-scraper": "🛒 SCRAPER",
  "coupang-1p-efficiency": "⚡ 1P-EFF",
  hanomad: "🏠 HANOMAD",
  "cc-deck": "🎛️ CC-DECK",
};

export function projectLabel(cwd: string): string {
  const base = path.basename(cwd.replace(/[\\/]+$/, ""));
  return PROJECT_LABELS[base] ?? base;
}

export async function ensureDeckDir(): Promise<void> {
  await fsp.mkdir(config.paths.deckDir, { recursive: true });
}

/**
 * Pick the context window size for a model id.
 *
 * The transcript records the *raw* API model id (e.g. "claude-opus-4-8") — the
 * "[1m]" suffix that Claude Code shows for the 1M-context beta never appears
 * there, so a plain "[1m]" check alone never fires on transcript data. Among
 * current models only Haiku is 200K; Opus 4.6/4.7/4.8, Sonnet 4.6/5, and
 * Fable/Mythos 5 all ship a 1M window (verified against the Claude model
 * catalog). Unknown/older ids fall back to the 200K default.
 */
export function contextWindowFor(model: string | undefined): number {
  const { big, default: def } = config.contextWindows;
  if (!model) return def;
  const m = model.toLowerCase();
  if (m.includes("[1m]")) return big; // honor the beta marker if it ever shows up
  if (m.includes("haiku")) return def; // Haiku (and older small models) are 200K
  if (
    /opus-4-[678]\b/.test(m) ||
    /sonnet-4-6\b/.test(m) ||
    /sonnet-5\b/.test(m) ||
    /(?:fable|mythos)-5\b/.test(m)
  ) {
    return big;
  }
  return def;
}

// ── Claude Code version watch ─────────────────────────────────────────────────
// The permission-prompt detector (server/sessions.ts) matches English strings in
// the CLI's UI. If a future Claude Code changes that wording, detection could
// silently stop working. To make that FAILURE VISIBLE instead of silent, we
// record the version this detector was last verified against and warn the user
// (a toast on page load) whenever the installed CLI differs — so they know to
// tell Claude to re-verify, rather than assuming cc-deck is broken.
//
// ⚠️ WHEN RE-VERIFYING the permission strings against a new CLI, bump this to the
// version you verified against so the warning clears.
export const VERIFIED_CLAUDE_VERSION = "2.1.212";

/** Best-effort: read the installed `claude --version` (e.g. "2.1.212"). Returns
 *  null if claude isn't found or the call fails — the warning just won't fire. */
export function detectClaudeVersion(): string | null {
  const isWin = process.platform === "win32";
  const shell = isWin ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/zsh");
  // Match how sessions.ts launches claude: a login+interactive shell so the
  // user's real PATH (~/.local/bin, Homebrew, shell functions) is in scope even
  // when cc-deck runs under launchd/systemd with a minimal PATH.
  const args = isWin ? ["/d", "/s", "/c", "claude --version"] : ["-l", "-i", "-c", "claude --version"];
  try {
    const out = execFileSync(shell, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** If the installed CLI differs from the verified version, return a user-facing
 *  warning string; otherwise null. Computed once at startup. */
export function claudeVersionWarning(): string | null {
  const installed = detectClaudeVersion();
  if (!installed || installed === VERIFIED_CLAUDE_VERSION) return null;
  return (
    `⚠️ Claude Code가 ${VERIFIED_CLAUDE_VERSION} → ${installed} 로 바뀌었어요. ` +
    `권한 승인창 감지는 ${VERIFIED_CLAUDE_VERSION} 기준으로 검증된 거라, 승인 대기인데 안 깜빡이면 ` +
    `문구가 바뀐 것일 수 있어요. 그때 클로드에게 "권한 깜빡임 재검증"이라고만 해주세요.`
  );
}
