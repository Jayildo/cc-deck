// ─────────────────────────────────────────────────────────────────────────────
// cc-deck shared contract
//
// This file is the single source of truth for the data shapes and the
// WebSocket protocol shared between the Fastify backend (server/) and the
// Vite frontend (web/). Backend modules (sessions / metrics / usage) are
// constructed with a handlers object and expose the interfaces below; the
// server (server/index.ts) wires their callbacks to WS broadcasts.
//
// DO NOT add runtime values here — it is imported by both Node (tsx) and the
// browser bundle, and must erase to nothing.
// ─────────────────────────────────────────────────────────────────────────────

// ── Core entities ────────────────────────────────────────────────────────────

export type SessionStatus =
  | "starting" // pty spawned, claudeSessionId not yet discovered
  | "active" // transcript appended within the last few seconds
  | "idle" // alive but quiet
  | "exited"; // pty process gone

export interface SessionMeta {
  /** cc-deck's own stable id for the session (uuid we mint at spawn). */
  id: string;
  /** Claude Code's session id (the transcript file stem), once discovered. */
  claudeSessionId?: string;
  /** OS pid of the claude process (best-effort). */
  pid?: number;
  /** Working directory the session was launched in. */
  cwd: string;
  /** Human label (defaults to the cwd basename / known project name). */
  title: string;
  status: SessionStatus;
  /** epoch ms */
  createdAt: number;
}

export interface TokenBucket {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** input + output + cacheCreation + cacheRead, deduped by (message.id, requestId). */
  total: number;
}

export interface SessionMetrics {
  id: string; // SessionMeta.id
  model?: string; // model of the latest main-chain assistant turn
  /** Context-window usage of the latest main-chain turn (approx, see notes). */
  contextPct?: number; // 0..100
  contextUsed?: number; // tokens in the live context
  contextWindow?: number; // 200_000 or 1_000_000
  /** Cumulative, deduped token totals across the whole transcript. */
  cumulative: TokenBucket;
  /** epoch ms of the last transcript append. */
  lastActivity?: number;
  /** Name of the most recent tool the assistant used (for the progress line). */
  lastTool?: string;
  /** Short human progress hint, e.g. "running Bash", "responding", "idle". */
  progress?: string;
  /** Coarse live activity state for the sidebar indicator, derived from the
   *  latest main-chain assistant record:
   *  - "working"         — a tool is running (Claude is busy)
   *  - "awaiting-choice" — AskUserQuestion / ExitPlanMode pending (user must pick)
   *  - "done"            — the turn ended with a text response (waiting on user)
   *  Undefined before the first submitted prompt. */
  activity?: "working" | "awaiting-choice" | "done";
  /** Number of assistant turns observed. */
  turnCount: number;
}

export interface UsageWindow {
  /** Percent of the window consumed, 0..100. undefined when unknown. */
  pct?: number;
  /** ISO timestamp when this window resets, if known. */
  resetsAt?: string;
}

export interface AccountUsage {
  /** Which source produced the currently-shown numbers. */
  source: "oauth" | "statusline" | "merged" | "none";
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  /** Subscription plan name, e.g. "max", from credentials/oauth. */
  plan?: string;
  /** Rate-limit tier label if available. */
  tier?: string;
  /** epoch ms the numbers were last refreshed. */
  updatedAt: number;
  /** True when the shown numbers are cached/old (poll failing). */
  stale: boolean;
  /** Degraded-state explanation, e.g. "reauth needed", "endpoint error". */
  error?: string;
}

// ── Project quick-pick (New Session) ─────────────────────────────────────────

export interface ProjectRef {
  /** Exact working directory, e.g. "C:\\project\\socp-erp". */
  path: string;
  /** Display label (known project name or basename). */
  label: string;
  /** epoch ms of last use (recent list only). */
  lastUsed?: number;
  favorite?: boolean;
}

export interface ProjectLists {
  favorites: ProjectRef[];
  recent: ProjectRef[];
}

// ── WebSocket protocol ───────────────────────────────────────────────────────

/** Messages the browser sends to the server. */
export type ClientMsg =
  | { t: "open"; cwd: string; title?: string }
  | { t: "attach"; id: string } // subscribe to a session's pty stream (server replays scrollback)
  | { t: "input"; id: string; data: string }
  | { t: "pasteImage"; id: string; ext: string; dataB64: string } // clipboard image → saved server-side, its path typed into the session
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "close"; id: string }
  | { t: "refreshUsage" }
  | { t: "listProjects" }
  | { t: "addFavorite"; path: string }
  | { t: "removeFavorite"; path: string }
  | { t: "listReports" }
  | { t: "getReport"; date: string }
  | { t: "generateReport" };

/** Messages the server pushes to the browser. */
export type ServerMsg =
  | { t: "hello"; version: string; sessions: SessionMeta[]; usage: AccountUsage; projects: ProjectLists }
  | { t: "sessions"; sessions: SessionMeta[] }
  | { t: "opened"; id: string } // ack to the client that sent "open" — auto-select this session

  | { t: "projects"; projects: ProjectLists }
  | { t: "scrollback"; id: string; data: string } // sent on attach
  | { t: "pty"; id: string; data: string }
  | { t: "metrics"; metrics: SessionMetrics }
  | { t: "usage"; usage: AccountUsage }
  | { t: "exit"; id: string; code: number }
  | { t: "reports"; dates: string[] }
  | { t: "report"; date: string; markdown: string }
  | { t: "reportStatus"; text: string; busy: boolean }
  | { t: "error"; message: string };

// ── Backend module interfaces (handler-injection pattern) ────────────────────
// Each factory takes a handlers object and returns the control surface. The
// server wires the handlers to broadcasts. This keeps modules decoupled — no
// module imports another.

export interface SessionManagerHandlers {
  onData(id: string, data: string): void;
  onSessions(sessions: SessionMeta[]): void;
  onExit(id: string, code: number): void;
}

export interface SessionManager {
  open(cwd: string, opts?: { title?: string }): Promise<SessionMeta>;
  /** Returns the meta + current scrollback buffer, or null if unknown. */
  attach(id: string): { meta: SessionMeta; scrollback: string } | null;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  list(): SessionMeta[];
  get(id: string): SessionMeta | undefined;
  dispose(): void;
}

export interface MetricsEngineHandlers {
  onMetrics(metrics: SessionMetrics): void;
}

export interface MetricsEngine {
  /** Start/refresh tracking for a session. Idempotent. Binds the transcript
   *  tailer once meta.claudeSessionId is known. */
  track(meta: SessionMeta): void;
  untrack(id: string): void;
  get(id: string): SessionMetrics | undefined;
  getAll(): SessionMetrics[];
  dispose(): void;
}

export interface UsagePollerHandlers {
  onUsage(usage: AccountUsage): void;
}

export interface UsagePoller {
  start(): void;
  stop(): void;
  get(): AccountUsage;
  /** Force an immediate refresh (used by the "refreshUsage" client msg). */
  refreshNow(): Promise<void>;
}
