import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.CC_DECK_PORT ?? 4317),

  /** How often the OAuth usage poller refreshes (ms). */
  usagePollMs: Number(process.env.CC_DECK_USAGE_POLL_MS ?? 60_000),

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
    /** Where the (optional) statusline tee appends live render payloads. */
    statuslineFeed: path.join(HOME, ".cc-deck", "statusline-feed.jsonl"),
    /** Built frontend served in production. */
    webDist: path.resolve(import.meta.dirname, "..", "web", "dist"),
  },

  /** Known context-window sizes by model family. */
  contextWindows: {
    big: 1_000_000, // [1m] / opus-4-6 / sonnet-4-6
    default: 200_000,
  },

  /** Anthropic OAuth usage endpoint (undocumented; may change). */
  oauth: {
    usageUrl: "https://api.anthropic.com/api/oauth/usage",
    beta: "oauth-2025-04-20",
  },
} as const;
