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
 * current models only Haiku is 200K; Opus/Sonnet ≥ 4.6 (incl. 5.x) and
 * Fable/Mythos all ship a 1M window (verified against the Claude model
 * catalog). Matched by generation, not an exact-id allow-list, so a new minor
 * (opus-5-1, opus-4-9) doesn't silently regress to 200K. Unknown/older ids fall
 * back to the 200K default.
 */
export function contextWindowFor(model: string | undefined): number {
  const { big, default: def } = config.contextWindows;
  if (!model) return def;
  const m = model.toLowerCase();
  if (m.includes("[1m]")) return big; // honor the beta marker if it ever shows up
  if (m.includes("haiku")) return def; // Haiku (and older small models) are 200K
  // \d{1,2} is load-bearing: it keeps date-suffixed legacy ids
  // (claude-sonnet-4-20250514, claude-opus-4-1-20250805) from reading the
  // date as a minor version.
  const gen = /(?:opus|sonnet)-(\d{1,2})(?:-(\d{1,2}))?\b/.exec(m);
  if (gen) {
    const major = Number(gen[1]);
    const minor = Number(gen[2] ?? 0);
    return major >= 5 || (major === 4 && minor >= 6) ? big : def;
  }
  if (/(?:fable|mythos)-\d+\b/.test(m)) return big;
  return def;
}

// ── Claude Code version watch ─────────────────────────────────────────────────
// The permission-prompt detector (server/sessions.ts PERMISSION_RE) matches
// English strings in the CLI's UI. If a future Claude Code rewords them,
// detection would silently stop working. Two layers keep that failure VISIBLE:
//  1. VERIFIED_CLAUDE_VERSION — the CLI the phrases were last checked against
//     by a human. Equal → nothing to do.
//  2. When the installed CLI differs (it auto-updates several times a week, so
//     this is the common case), the server scans the CLI bundle itself for the
//     source fragments behind PERMISSION_RE. All present → silently accepted
//     (logged); any missing, or the bundle can't be located → warning toast so
//     the user knows to ask Claude to re-verify.
//
// ⚠️ WHEN RE-VERIFYING by hand, bump this to the version you checked (what
// `cmd /d /s /c claude --version` prints from the SERVER env — %APPDATA%\npm on
// Windows, not an fnm/Git-Bash shim that may shadow it).
export const VERIFIED_CLAUDE_VERSION = "2.1.234";

/** Verbatim fragments in the CLI bundle behind sessions.ts PERMISSION_RE. The
 *  "Do you want to X" prompt is assembled at render time from "Do you want to "
 *  + verbPhrase ("make this edit to", "create", …), so the check looks for the
 *  pieces, not the rendered sentence. "t ask again" covers don't / don’t. */
const PERMISSION_BUNDLE_PHRASES = [
  "Do you want to proceed",
  "make this edit to",
  "t ask again",
  "tell Claude what to do differently",
];

// Memoised: `claude --version` boots the whole CLI (~1s, blocking) and both the
// startup warning and usage.ts's User-Agent need it — spawn once.
let detectedClaudeVersion: string | null | undefined;

/** Run `claude <args>` the way sessions.ts launches it (cmd.exe on Windows, a
 *  login+interactive shell elsewhere so the user's real PATH is in scope even
 *  under launchd/systemd) and return trimmed stdout, or null on any failure. */
function claudeShellOut(cmd: string): string | null {
  const isWin = process.platform === "win32";
  const shell = isWin ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/zsh");
  const args = isWin ? ["/d", "/s", "/c", cmd] : ["-l", "-i", "-c", cmd];
  try {
    return execFileSync(shell, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Best-effort: read the installed `claude --version` (e.g. "2.1.234"). Returns
 *  null if claude isn't found or the call fails — the warning just won't fire. */
export function detectClaudeVersion(): string | null {
  if (detectedClaudeVersion !== undefined) return detectedClaudeVersion;
  detectedClaudeVersion = claudeShellOut("claude --version")?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  return detectedClaudeVersion;
}

/** Locate the CLI's big bundle (native exe or cli.js) starting from whatever
 *  `claude` resolves to on PATH: an npm .cmd shim / wrapper script next to
 *  node_modules/@anthropic-ai/claude-code, or a native install (~/.local/bin/claude
 *  → versions/<v>). Returns null when nothing plausible (> 5 MB) is found. */
function locateClaudeBundle(): string | null {
  const isWin = process.platform === "win32";
  const first = claudeShellOut(isWin ? "where claude" : "command -v claude")?.split(/\r?\n/)[0]?.trim();
  if (!first || !path.isAbsolute(first)) return null;
  const big = (p: string): string | null => {
    try { return fs.statSync(p).size > 5 * 1024 * 1024 ? p : null; } catch { return null; }
  };
  let p = first;
  try { p = fs.realpathSync(p); } catch { /* keep as-is */ }
  if (big(p)) return p; // native install: PATH entry is (a link to) the binary itself
  // npm install: shim/wrapper lives next to node_modules/@anthropic-ai/claude-code
  const idx = p.replace(/\\/g, "/").indexOf("/node_modules/@anthropic-ai/claude-code");
  const pkg = idx >= 0 ? p.slice(0, idx) + "/node_modules/@anthropic-ai/claude-code" : path.join(path.dirname(p), "node_modules", "@anthropic-ai", "claude-code");
  const nm = path.dirname(pkg);
  const candidates = [path.join(pkg, "bin", "claude.exe"), path.join(pkg, "bin", "claude"), path.join(pkg, "cli.js")];
  try {
    for (const d of fs.readdirSync(nm)) {
      if (d.startsWith("claude-code-")) candidates.push(path.join(nm, d, "claude.exe"), path.join(nm, d, "claude"));
    }
  } catch { /* no platform packages */ }
  for (const c of candidates) if (big(c)) return c;
  return null;
}

/** Stream the bundle and check every PERMISSION_BUNDLE_PHRASES fragment is in
 *  it. "ok" | "missing" (some fragment gone → the prompt was likely reworded) |
 *  "unknown" (bundle not found / unreadable). */
async function verifyPermissionPhrases(): Promise<{ status: "ok" | "missing" | "unknown"; bundle: string | null }> {
  const bundle = locateClaudeBundle();
  if (!bundle) return { status: "unknown", bundle: null };
  const pending = new Set(PERMISSION_BUNDLE_PHRASES);
  const overlap = Math.max(...PERMISSION_BUNDLE_PHRASES.map((s) => s.length));
  let carry = "";
  try {
    for await (const chunk of fs.createReadStream(bundle, { highWaterMark: 1 << 20 })) {
      const text = carry + (chunk as Buffer).toString("latin1");
      for (const phrase of pending) if (text.includes(phrase)) pending.delete(phrase);
      if (pending.size === 0) break;
      carry = text.slice(-overlap);
    }
  } catch {
    return { status: "unknown", bundle };
  }
  return { status: pending.size === 0 ? "ok" : "missing", bundle };
}

/** If the installed CLI differs from the verified version AND its bundle no
 *  longer carries the permission-prompt phrases (or can't be checked), return a
 *  user-facing warning string; otherwise null. Computed once at startup. */
export async function claudeVersionWarning(): Promise<string | null> {
  const installed = detectClaudeVersion();
  if (!installed || installed === VERIFIED_CLAUDE_VERSION) return null;
  const { status, bundle } = await verifyPermissionPhrases();
  if (status === "ok") {
    console.log(`[cc-deck] Claude Code ${installed} (verified: ${VERIFIED_CLAUDE_VERSION}) — permission phrases still present in ${bundle}, no re-verification needed`);
    return null;
  }
  const why = status === "missing"
    ? `설치된 CLI에서 권한 승인창 문구 일부가 사라졌어요(${bundle}) — 문구가 바뀐 것 같아요.`
    : `CLI 본체를 찾지 못해 승인창 문구를 자동 확인하지 못했어요.`;
  return (
    `⚠️ Claude Code가 ${VERIFIED_CLAUDE_VERSION} → ${installed} 로 바뀌었어요. ${why} ` +
    `승인 대기인데 안 깜빡이면 클로드에게 "권한 깜빡임 재검증"이라고만 해주세요.`
  );
}
