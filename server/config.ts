import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.CC_DECK_PORT ?? 4317),

  /** How often the OAuth usage poller refreshes (ms). */
  usagePollMs: Number(process.env.CC_DECK_USAGE_POLL_MS ?? 60_000),

  /** Local time (HH:MM) to auto-generate the daily report. */
  reportTime: process.env.CC_DECK_REPORT_TIME ?? "23:30",

  /** Default shape for newly-spawned terminals. */
  defaultCols: 120,
  defaultRows: 30,
  /** Max bytes of scrollback kept per session for replay-on-attach. */
  scrollbackBytes: 256 * 1024,

  isProd: process.env.NODE_ENV === "production",

  paths: {
    home: HOME,
    claudeDir: path.join(HOME, ".claude"),
    sessionsDir: path.join(HOME, ".claude", "sessions"),
    projectsDir: path.join(HOME, ".claude", "projects"),
    credentials: path.join(HOME, ".claude", ".credentials.json"),
    /** cc-deck's own state dir. */
    deckDir: path.join(HOME, ".cc-deck"),
    usageCache: path.join(HOME, ".cc-deck", "usage-cache.json"),
    /** Where pasted clipboard images are written before their path is typed into a session. */
    pasteDir: path.join(HOME, ".cc-deck", "paste"),
    /** Where the (optional) statusline tee appends live render payloads. */
    statuslineFeed: path.join(HOME, ".cc-deck", "statusline-feed.jsonl"),
    /** Built frontend served in production. */
    webDist: path.resolve(import.meta.dirname, "..", "web", "dist"),
  },

  /** Known context-window sizes by model family (see util.contextWindowFor). */
  contextWindows: {
    big: 1_000_000, // Opus 4.6/4.7/4.8, Sonnet 4.6/5, Fable/Mythos 5, or [1m] beta
    default: 200_000, // Haiku and older/unknown models
  },

  /** Anthropic OAuth usage endpoint (undocumented; may change). */
  oauth: {
    usageUrl: "https://api.anthropic.com/api/oauth/usage",
    beta: "oauth-2025-04-20",
  },
} as const;
