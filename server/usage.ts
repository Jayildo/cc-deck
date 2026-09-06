import { execSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";
import { detectClaudeVersion, readJsonSafe, VERIFIED_CLAUDE_VERSION } from "./util.js";
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

// Claude Code stores its OAuth token in a file on Windows/Linux
// (~/.claude/.credentials.json) but in the login **Keychain** on macOS, under
// the service "Claude Code-credentials". Try the file first, then the Keychain,
// so the account 5h/7d usage resolves on every platform.
async function readCredentials(): Promise<Credentials | null> {
  const fromFile = await readJsonSafe<Credentials>(config.paths.credentials);
  if (fromFile?.claudeAiOauth?.accessToken) return fromFile;

  if (process.platform === "darwin") {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        encoding: "utf8",
        timeout: 5_000,
      }).trim();
      const parsed = JSON.parse(raw) as Credentials;
      if (parsed?.claudeAiOauth?.accessToken) return parsed;
    } catch {
      // not in the Keychain, or access denied — fall through to null
    }
  }
  return null;
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
    if (typeof v === "number") {
      // An out-of-range epoch yields Invalid Date and toISOString() would
      // throw — skip to the next candidate field instead.
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
      continue;
    }
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Retry-After → ms. Accepts delta-seconds or an HTTP-date; undefined when the
 *  header is absent or unparseable (then the caller's exponential backoff applies). */
function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = h.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

function parseOAuthResponse(body: RawOAuthUsage): Pick<AccountUsage, "fiveHour" | "sevenDay"> {
  const rawFive = body.five_hour ?? body.rate_limits?.five_hour ?? null;
  const rawSeven = body.seven_day ?? body.rate_limits?.seven_day ?? null;
  return {
    fiveHour: rawFive ? { pct: pickPct(rawFive), resetsAt: pickResetsAt(rawFive) } : {},
    sevenDay: rawSeven ? { pct: pickPct(rawSeven), resetsAt: pickResetsAt(rawSeven) } : {},
  };
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
  const baseMs = handlers.intervalMs ?? 60_000;

  /** Why the OAuth source produced no numbers this cycle. Deliberately not an
   *  AccountUsage — the old expired-token branch returned a truthy
   *  AccountUsage, which short-circuited computeOnce and made tryStatusline()
   *  unreachable in exactly the case it exists for. */
  type AuthNote = Pick<AccountUsage, "error" | "needsLogin"> & {
    /** The endpoint itself pushed back (429/5xx/network) — the scheduler backs
     *  off instead of re-hitting it at the base cadence. retryAfterMs is the
     *  server's Retry-After when it sent one. Stripped before the note reaches
     *  an AccountUsage (it is scheduling state, not something the UI shows). */
    throttle?: { retryAfterMs?: number };
  };

  // Red means the user has to act (/login), so it needs corroboration — a
  // one-off 401 or a macOS Keychain prompt must not flip the badge red by
  // itself. Only two red diagnoses in a row set needsLogin. needsLogin here
  // means only "this cycle is red"; the consecutive-strike accounting happens
  // at commit time, inside refreshNow's generation guard — an abandoned cycle
  // settling late must not reset a live cycle's strikes.
  function diagnose(error: string, red = false): AuthNote {
    return { error, needsLogin: red };
  }

  // Source A: OAuth (accurate, includes reset times).
  async function tryOAuth(signal: AbortSignal): Promise<AccountUsage | AuthNote> {
    const creds = await readCredentials();
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return diagnose("로그인 필요", true);

    if (oauth.expiresAt <= Date.now()) {
      // Local-clock expiry is a guess, not evidence — the CLI's own lazy
      // refresh usually heals this within a minute of any `claude` run. Just
      // report it and let computeOnce fall through to statusline/cache
      // instead of short-circuiting here with a fabricated AccountUsage.
      return diagnose("토큰 만료");
    }

    let parsed: Pick<AccountUsage, "fiveHour" | "sevenDay">;
    try {
      const resp = await fetch(config.oauth.usageUrl, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": config.oauth.beta,
          "anthropic-version": "2023-06-01",
          "User-Agent": `claude-cli/${detectClaudeVersion() ?? VERIFIED_CLAUDE_VERSION}`,
        },
        // 15s cap (undici's default headers timeout is 300s — a stalled
        // connection would otherwise pin one poll for 5 min) + the cycle's
        // abandon signal, so a wedge the timer misses is torn down for real.
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!resp.ok) {
        // Release the connection — an unread error body keeps its socket reserved.
        void resp.body?.cancel().catch(() => undefined);
        // 401/403 is the only real evidence the token is dead; anything else
        // (429/5xx) is the endpoint being unhappy, not a login problem — and
        // hitting it again in 60s only earns another 429, so flag it for backoff.
        if (resp.status === 401 || resp.status === 403) return diagnose("재로그인 필요", true);
        return {
          ...diagnose(`사용량 API ${resp.status}`),
          throttle: { retryAfterMs: parseRetryAfter(resp.headers.get("retry-after")) },
        };
      }
      // Parse inside the try: a malformed body must fall through to the
      // statusline/cache fallbacks, not reject the whole cycle.
      parsed = parseOAuthResponse((await resp.json()) as RawOAuthUsage);
    } catch {
      return { ...diagnose("사용량 조회 실패"), throttle: {} };
    }

    return {
      source: "oauth",
      ...parsed,
      plan: oauth.subscriptionType,
      tier: oauth.rateLimitTier,
      updatedAt: Date.now(),
      stale: false,
    };
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
      // The feed's mtime, not Date.now() — this is up to 10 min old data and
      // the client renders that age to the user.
      updatedAt: mtimeMs,
      stale: false,
    };
  }

  // One poll cycle: OAuth -> statusline -> stale cache -> none. Returns the
  // result instead of committing it so refreshNow can drop an abandoned cycle.
  // The throttle flag rides alongside (never inside) the AccountUsage.
  async function computeOnce(signal: AbortSignal): Promise<{ u: AccountUsage; throttle?: AuthNote["throttle"] }> {
    const r = await tryOAuth(signal);
    if ("source" in r) return { u: r }; // fresh OAuth numbers — nothing to diagnose
    const { throttle, ...note } = r;

    const sl = tryStatusline();
    if (sl) return { u: { ...sl, ...note }, throttle };

    const cached = await readJsonSafe<AccountUsage>(config.paths.usageCache);
    if (cached) {
      // The cache carries its *own* past diagnosis — drop it. Only this
      // cycle's note is true, or a red badge would persist forever by
      // round-tripping through the cache file.
      const { error: _e, needsLogin: _n, ...rest } = cached;
      return { u: { ...rest, stale: true, ...note }, throttle };
    }

    // No numbers ever obtained — updatedAt: 0 (from NONE) is honest;
    // Date.now() here would claim a refresh that never happened.
    return { u: { ...NONE, ...note }, throttle };
  }

  // ── Backoff ──────────────────────────────────────────────────────────────────
  // The usage endpoint rate-limits sporadically (2026-09-04: ~170 lone 429s in
  // 37h — every one flipped the badge amber and wrote two log lines, and the
  // very next 60s poll succeeded). On push-back: honour Retry-After, else double
  // the gap (cap 10 min, ±10% jitter so we stop re-colliding with the CLI's own
  // polls); any success snaps back to the base cadence. While the numbers on
  // screen are still recent (< STALE_AFTER_MS, the same bar get() uses) a
  // throttled cycle keeps them silently — only sustained trouble turns amber.
  const MAX_BACKOFF_MS = 10 * 60_000;
  const STALE_AFTER_MS = 5 * baseMs;
  const THROTTLE_LOG_GAP_MS = 60 * 60_000;
  let backoffMs = 0; // 0 = healthy cadence
  let throttleLoggedAt = 0;
  function nextBackoff(retryAfterMs?: number): number {
    const want = retryAfterMs !== undefined ? Math.max(retryAfterMs, baseMs) : (backoffMs || baseMs) * 2;
    return Math.min(MAX_BACKOFF_MS, want);
  }

  // Coalesce overlapping calls (interval tick + user "refresh" spam + a slow
  // network) so an older response can never overwrite a newer one. The slot is
  // deadline-capped: a cycle that never settles must not disable the poller
  // until restart (2026-08-18: a fetch wedged across sleep/wake stayed pending
  // forever and froze usage for days). On expiry the old cycle is explicitly
  // aborted (the wedge's own timeout timer may be lost — only an abort tears
  // the socket down) and the generation guard drops a late straggler's commit.
  const INFLIGHT_DEADLINE_MS = 45_000;
  let inflight: Promise<void> | null = null;
  let inflightSince = 0;
  let inflightAbort: AbortController | null = null;
  let gen = 0;
  // Cache writes are chained: two committed cycles' unordered writeFiles could
  // otherwise interleave truncate/write on the same path (older wins / garbage).
  let cacheWrite: Promise<unknown> = Promise.resolve();
  // Transition log: a 60s poller writing every cycle would be 1440 lines/day,
  // so only log when the degraded-state reason actually changes — otherwise
  // an overnight red badge leaves no trace (server.log has only the boot banner).
  let loggedNote = "";
  // Red means the user has to act (/login), so it needs corroboration — a
  // one-off 401 or a macOS Keychain prompt must not flip the badge red by
  // itself. Only two red diagnoses in a row set needsLogin. Lives here, not
  // inside diagnose()/tryOAuth, so an abandoned cycle settling late (past the
  // gen guard below) can never touch a live cycle's count.
  let redStrikes = 0;
  function refreshNow(): Promise<void> {
    if (inflight && Date.now() - inflightSince < INFLIGHT_DEADLINE_MS) return inflight;
    inflightAbort?.abort();
    const ac = new AbortController();
    inflightAbort = ac;
    const myGen = ++gen;
    inflightSince = Date.now();
    const p = computeOnce(ac.signal)
      .then(({ u: u0, throttle }) => {
        if (myGen !== gen) return; // abandoned cycle settled late — drop it
        if (throttle) {
          backoffMs = nextBackoff(throttle.retryAfterMs);
          // One line per hour at most: a trace that the endpoint is pushing
          // back, without the per-blip flood this replaces.
          if (Date.now() - throttleLoggedAt > THROTTLE_LOG_GAP_MS) {
            throttleLoggedAt = Date.now();
            console.warn(`[cc-deck] usage throttled: ${u0.error} — backing off to ${Math.round(backoffMs / 1000)}s`);
          }
          // Recent numbers on screen → keep them; the badge stays green.
          if (last.source === "oauth" && !last.stale && Date.now() - last.updatedAt < STALE_AFTER_MS) return;
        } else {
          backoffMs = 0;
        }
        // Consecutive-red accounting lives inside the guard: a superseded
        // cycle must not reset the strikes a live cycle just earned.
        redStrikes = u0.needsLogin ? redStrikes + 1 : 0;
        const u: AccountUsage = u0.error ? { ...u0, needsLogin: redStrikes >= 2 } : u0;
        const key = u.error ?? "";
        if (key !== loggedNote) {
          loggedNote = key;
          console.warn(key ? `[cc-deck] usage degraded: ${key} (source=${u.source})`
                           : "[cc-deck] usage recovered");
        }
        last = u;
        handlers.onUsage(u);
        if (u.source === "oauth" && !u.stale) {
          // Persist to cache (best-effort).
          cacheWrite = cacheWrite
            .then(() => fsp.writeFile(config.paths.usageCache, JSON.stringify(u), "utf8"))
            .catch(() => undefined);
        }
      })
      .catch((err) => {
        // computeOnce shouldn't reject (every source catches its own errors) —
        // if it somehow does, say so instead of silently freezing usage.
        console.error("[cc-deck] usage refresh failed:", err);
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  }

  // A setTimeout chain instead of setInterval so the gap can follow backoffMs.
  // Only the chain calls scheduleNext (a client's refreshUsage never does), so
  // there is exactly one pending timer at any time.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  function scheduleNext(): void {
    if (!running) return;
    if (timer !== null) clearTimeout(timer);
    const delay = backoffMs > 0 ? Math.round(backoffMs * (0.9 + Math.random() * 0.2)) : baseMs;
    timer = setTimeout(() => {
      timer = null;
      void refreshNow().finally(scheduleNext);
    }, delay);
  }

  function start(): void {
    running = true;
    void refreshNow().finally(scheduleNext);
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function get(): AccountUsage {
    // hello snapshot: if the last update is ancient (poller dead in a way the
    // watchdog didn't catch), at least show amber "stale", not a healthy badge.
    const ancient = last.updatedAt > 0 && Date.now() - last.updatedAt > STALE_AFTER_MS;
    return ancient ? { ...last, stale: true } : last;
  }

  return { start, stop, get, refreshNow };
}
