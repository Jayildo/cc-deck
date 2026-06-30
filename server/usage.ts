import { execSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";
import { readJsonSafe } from "./util.js";
import type { AccountUsage, UsagePoller, UsagePollerHandlers } from "../shared/types.js";

// ── Credentials ───────────────────────────────────────────────────────────────

interface ClaudeAiOauth {
  accessToken: string;
  expiresAt: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}
interface Credentials {
  claudeAiOauth?: ClaudeAiOauth;
}

// ── OAuth response (real shape from probe; defensive variants listed) ─────────
// Real shape confirmed: five_hour.utilization (number, already-pct), .resets_at (ISO)
// Defensive support: nested under .rate_limits; pct field named utilization|used_percentage|used
// (if <= 1 treat as fraction); reset field named resets_at|reset_at|resetsAt (ISO or epoch ms).

interface RawWindow {
  utilization?: number | null;
  used_percentage?: number | null;
  used?: number | null;
  resets_at?: string | number | null;
  reset_at?: string | number | null;
  resetsAt?: string | number | null;
}

interface RawOAuthUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  rate_limits?: {
    five_hour?: RawWindow | null;
    seven_day?: RawWindow | null;
  } | null;
}

// Statusline JSONL payload shape (matches statusline-command.sh extraction).
interface StatuslinePayload {
  rate_limits?: {
    five_hour?: { used_percentage?: number | null };
    seven_day?: { used_percentage?: number | null };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickPct(w: RawWindow): number | undefined {
  // utilization / used_percentage are already server-side percents (0..100),
  // confirmed against the live endpoint and the statusline payload. Do NOT
  // rescale — an earlier "<=1 ? *100" heuristic misread sub-1% usage as ×100.
  for (const v of [w.utilization, w.used_percentage, w.used]) {
    if (typeof v === "number") return Math.max(0, Math.min(100, v));
  }
  return undefined;
}

function pickResetsAt(w: RawWindow): string | undefined {
  for (const v of [w.resets_at, w.reset_at, w.resetsAt]) {
    if (typeof v === "number") return new Date(v).toISOString();
    if (typeof v === "string") return v;
  }
  return undefined;
}

function parseOAuthResponse(body: RawOAuthUsage): Pick<AccountUsage, "fiveHour" | "sevenDay"> {
  const rawFive = body.five_hour ?? body.rate_limits?.five_hour ?? null;
  const rawSeven = body.seven_day ?? body.rate_limits?.seven_day ?? null;
  return {
    fiveHour: rawFive ? { pct: pickPct(rawFive), resetsAt: pickResetsAt(rawFive) } : {},
    sevenDay: rawSeven ? { pct: pickPct(rawSeven), resetsAt: pickResetsAt(rawSeven) } : {},
  };
}

// Resolved once on first use.
let cachedClaudeVer: string | null = null;
function getClaudeVersion(): string {
  if (cachedClaudeVer !== null) return cachedClaudeVer;
  try {
    const out = execSync("claude --version", { encoding: "utf8", timeout: 5_000 }).trim();
    cachedClaudeVer = /^(\S+)/.exec(out)?.[1] ?? "2.1.0";
  } catch {
    cachedClaudeVer = "2.1.0";
  }
  return cachedClaudeVer;
}

// ── Factory ───────────────────────────────────────────────────────────────────

const NONE: AccountUsage = {
  source: "none",
  fiveHour: {},
  sevenDay: {},
  updatedAt: 0,
  stale: true,
};

export function createUsagePoller(
  handlers: UsagePollerHandlers & { intervalMs?: number }
): UsagePoller {
  let last: AccountUsage = { ...NONE };
  let timer: ReturnType<typeof setInterval> | null = null;

  // Source A: OAuth (accurate, includes reset times).
  async function tryOAuth(): Promise<AccountUsage | null> {
    const creds = await readJsonSafe<Credentials>(config.paths.credentials);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;

    if (oauth.expiresAt <= Date.now()) {
      // Token expired — load cache and surface the error; no refresh in v1.
      const cached = await readJsonSafe<AccountUsage>(config.paths.usageCache);
      return cached
        ? { ...cached, stale: true, error: "reauth needed" }
        : {
            source: "oauth",
            fiveHour: {},
            sevenDay: {},
            plan: oauth.subscriptionType,
            tier: oauth.rateLimitTier,
            updatedAt: Date.now(),
            stale: true,
            error: "reauth needed",
          };
    }

    let body: RawOAuthUsage;
    try {
      const resp = await fetch(config.oauth.usageUrl, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": config.oauth.beta,
          "anthropic-version": "2023-06-01",
          "User-Agent": `claude-cli/${getClaudeVersion()}`,
        },
      });
      if (!resp.ok) return null;
      body = (await resp.json()) as RawOAuthUsage;
    } catch {
      return null;
    }

    const { fiveHour, sevenDay } = parseOAuthResponse(body);
    const result: AccountUsage = {
      source: "oauth",
      fiveHour,
      sevenDay,
      plan: oauth.subscriptionType,
      tier: oauth.rateLimitTier,
      updatedAt: Date.now(),
      stale: false,
    };

    // Persist to cache (best-effort).
    fsp.writeFile(config.paths.usageCache, JSON.stringify(result), "utf8").catch(() => undefined);

    return result;
  }

  // Source B: Statusline feed (opt-in tee, no reset times).
  function tryStatusline(): AccountUsage | null {
    const feedPath = config.paths.statuslineFeed;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(feedPath).mtimeMs;
    } catch {
      return null;
    }
    if (Date.now() - mtimeMs > 10 * 60_000) return null; // older than 10 min

    let rawLine: string;
    try {
      const content = fs.readFileSync(feedPath, "utf8");
      const lines = content.trimEnd().split("\n");
      rawLine = lines[lines.length - 1] ?? "";
    } catch {
      return null;
    }
    if (!rawLine) return null;

    let payload: StatuslinePayload;
    try {
      payload = JSON.parse(rawLine) as StatuslinePayload;
    } catch {
      return null;
    }

    const rl = payload.rate_limits;
    const fiveRaw = rl?.five_hour?.used_percentage;
    const sevenRaw = rl?.seven_day?.used_percentage;

    const toPct = (v: number | null | undefined): number | undefined =>
      typeof v === "number" ? Math.max(0, Math.min(100, v)) : undefined;

    return {
      source: "statusline",
      fiveHour: { pct: toPct(fiveRaw) },
      sevenDay: { pct: toPct(sevenRaw) },
      updatedAt: Date.now(),
      stale: false,
    };
  }

  // One poll cycle: OAuth -> statusline -> stale cache -> none.
  async function refreshNow(): Promise<void> {
    const oauth = await tryOAuth();
    if (oauth) {
      last = oauth;
      handlers.onUsage(last);
      return;
    }

    const sl = tryStatusline();
    if (sl) {
      last = sl;
      handlers.onUsage(last);
      return;
    }

    const cached = await readJsonSafe<AccountUsage>(config.paths.usageCache);
    if (cached) {
      last = { ...cached, stale: true };
      handlers.onUsage(last);
      return;
    }

    last = { ...NONE, updatedAt: Date.now() };
    handlers.onUsage(last);
  }

  function start(): void {
    void refreshNow();
    timer = setInterval(() => void refreshNow(), handlers.intervalMs ?? 60_000);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function get(): AccountUsage {
    return last;
  }

  return { start, stop, get, refreshNow };
}
