import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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

/** Pick the context window size for a model id. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return config.contextWindows.default;
  const m = model.toLowerCase();
  if (m.includes("[1m]") || m.includes("opus-4-6") || m.includes("sonnet-4-6")) {
    return config.contextWindows.big;
  }
  return config.contextWindows.default;
}
