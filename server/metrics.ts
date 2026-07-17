import fs from "node:fs";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type {
  MetricsEngine,
  MetricsEngineHandlers,
  SessionMeta,
  SessionMetrics,
} from "../shared/types.js";
import { findTranscriptPath, contextWindowFor } from "./util.js";

// ─── Transcript record shapes (defensive — only fields we actually use) ────────

interface TUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TContent {
  type: string;
  name?: string;
}

interface TMessage {
  id?: string;
  model?: string;
  usage?: TUsage;
  content?: TContent[];
  /** API stop reason — the authoritative "turn over vs still working" signal. */
  stop_reason?: string | null;
}

interface TRecord {
  type?: string;
  uuid?: string;
  requestId?: string;
  isSidechain?: boolean | null;
  timestamp?: string;
  message?: TMessage;
}

// Tools whose tool_use pauses the turn for the USER to pick an option, rather
// than Claude continuing to work — surfaced in the sidebar as "awaiting-choice".
// Names must match the transcript tool_use `name` exactly.
const CHOICE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// stop_reason values that mean the turn is genuinely OVER (user's turn now).
// Anything else ("tool_use", "pause_turn", null while still streaming) means
// Claude is still working — so we must NOT flip the row to "done".
const DONE_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

// A main-chain turn can hit a terminal stop_reason (end_turn) while the session
// is STILL working — e.g. it launched a background agent or a dynamic workflow
// and is now waiting for them to finish. That background work writes NOTHING to
// this transcript (not even sidechain lines — verified: 12 min of silence), so
// the transcript alone can't tell "genuinely done" from "waiting on background
// work" — both look like end_turn followed by quiet. The PTY can: Claude Code's
// spinner keeps emitting (its elapsed-time counter ticks ≤1s) the whole time it
// works, and goes quiet only at the idle prompt. So we DEFER committing a
// terminal ("done"/"awaiting-choice") state until the PTY has been silent this
// long — long enough to clear the spinner's inter-frame gap. See notePtyOutput.
const SETTLE_MS = 3000;

// ─── Per-session tracking state ───────────────────────────────────────────────

interface SessionState {
  metrics: SessionMetrics;
  /** Dedup keys: `${message.id ?? uuid}:${requestId ?? ""}` */
  seen: Set<string>;
  /** Byte offset into the transcript file (for incremental reads). */
  byteOffset: number;
  filePath: string | null;
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Terminal activity ("done"/"awaiting-choice") seen in the transcript but not
   *  yet shown, because the PTY may still be busy (background agent/workflow).
   *  Committed only after the PTY goes quiet for SETTLE_MS. */
  pendingTerminal: "done" | "awaiting-choice" | null;
  /** ms timestamp of the last PTY byte for this session (0 = none yet). */
  lastPtyAt: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMetricsEngine(handlers: MetricsEngineHandlers): MetricsEngine {
  const states = new Map<string, SessionState>();

  function makeEmpty(id: string): SessionMetrics {
    return {
      id,
      cumulative: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
      turnCount: 0,
      progress: "idle",
    };
  }

  function snapshot(s: SessionState): SessionMetrics {
    return { ...s.metrics, cumulative: { ...s.metrics.cumulative } };
  }

  function scheduleEmit(s: SessionState): void {
    if (s.debounceTimer !== null) clearTimeout(s.debounceTimer);
    s.debounceTimer = setTimeout(() => {
      s.debounceTimer = null;
      handlers.onMetrics(snapshot(s));
    }, 150);
  }

  function emitNow(s: SessionState): void {
    if (s.debounceTimer !== null) {
      clearTimeout(s.debounceTimer);
      s.debounceTimer = null;
    }
    handlers.onMetrics(snapshot(s));
  }

  // Show the deferred terminal state (see SETTLE_MS). Clears the pending flag.
  function commitTerminal(s: SessionState): void {
    if (s.settleTimer !== null) {
      clearTimeout(s.settleTimer);
      s.settleTimer = null;
    }
    const term = s.pendingTerminal;
    s.pendingTerminal = null;
    if (!term || s.metrics.activity === term) return;
    s.metrics.activity = term;
    s.metrics.progress = term === "awaiting-choice" ? "awaiting choice" : "idle";
    emitNow(s);
  }

  // Poll until the PTY has been silent for SETTLE_MS, then commit the terminal
  // state. Each fresh PTY byte pushes lastPtyAt forward, so an active spinner
  // (background wait) keeps rescheduling and never lets us flip to "done".
  function scheduleSettle(s: SessionState): void {
    if (s.settleTimer !== null) clearTimeout(s.settleTimer);
    s.settleTimer = setTimeout(() => {
      s.settleTimer = null;
      if (!s.pendingTerminal) return;
      const quiet = Date.now() - s.lastPtyAt;
      if (quiet >= SETTLE_MS) commitTerminal(s);
      else scheduleSettle(s);
    }, SETTLE_MS);
  }

  /**
   * Parse one JSONL line and mutate state.
   * Returns true if anything the UI cares about changed (new token totals OR a
   * change in activity), so the caller knows to schedule an emit.
   */
  function processLine(s: SessionState, raw: string): boolean {
    let rec: TRecord;
    try {
      rec = JSON.parse(raw) as TRecord;
    } catch {
      return false;
    }
    if (rec.type !== "assistant") return false;
    const usage = rec.message?.usage;
    if (!usage) return false;

    // Claude Code writes ONE API response as several JSONL lines — one per content
    // block (thinking, text, tool_use, …) — all sharing the same message.id +
    // requestId (and echoing the same usage). We must therefore split concerns:
    //   • token/context/turnCount: count ONCE per response (dedup key gates it),
    //     else ~Nx overcount.
    //   • activity: derive from EVERY line (see below) — the authoritative
    //     stop_reason / real tool_use arrives on a LATER line than the first
    //     "thinking"/"text" line, so dedup-gating activity would misread the turn.
    const msgId = rec.message?.id ?? rec.uuid ?? "";
    const reqId = rec.requestId ?? "";
    const key = `${msgId}:${reqId}`;
    const isNew = !s.seen.has(key);
    if (isNew) s.seen.add(key);

    let changed = false;

    // ── Tokens + context window + turn count: once per response ──
    if (isNew) {
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;

      const c = s.metrics.cumulative;
      c.input += input;
      c.output += output;
      c.cacheCreation += cacheCreation;
      c.cacheRead += cacheRead;
      c.total = c.input + c.output + c.cacheCreation + c.cacheRead;

      // Context window — always overwrite with the most recent main-chain turn
      if (rec.isSidechain !== true) {
        const model = rec.message?.model;
        const window = contextWindowFor(model);
        const used = input + output + cacheCreation + cacheRead;
        s.metrics.model = model;
        s.metrics.contextWindow = window;
        s.metrics.contextUsed = used;
        s.metrics.contextPct = Math.round((used / window) * 100);
      }

      s.metrics.turnCount++;
      changed = true;
    }

    // Timing — cheap, refresh on every line
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    s.metrics.lastActivity = isNaN(ts) ? Date.now() : ts;

    // ── Activity: derived from EVERY main-chain line, keyed off stop_reason ──
    // stop_reason is the real "turn over vs still working" signal. A text/thinking
    // line carrying stop_reason:"tool_use" means Claude is STILL working (a tool
    // call follows on a later line) — the old logic mistook it for "done", which
    // is why rows blinked "완료" at the start of and all through a turn.
    if (rec.isSidechain !== true) {
      const stop = rec.message?.stop_reason;
      const toolUse = rec.message?.content?.find((item) => item.type === "tool_use");
      if (toolUse?.name) s.metrics.lastTool = toolUse.name;

      let raw: "working" | "awaiting-choice" | "done";
      if (stop && DONE_REASONS.has(stop)) {
        raw = "done"; // main-chain turn ended — but may still be waiting (see below)
      } else if (toolUse?.name && CHOICE_TOOLS.has(toolUse.name)) {
        raw = "awaiting-choice"; // AskUserQuestion / ExitPlanMode — user must pick
      } else {
        raw = "working"; // tool_use / pause_turn / null(mid-stream) = still working
      }

      if (raw === "working") {
        // Unambiguously working — show it now and cancel any deferred terminal.
        s.pendingTerminal = null;
        if (s.settleTimer !== null) {
          clearTimeout(s.settleTimer);
          s.settleTimer = null;
        }
        s.metrics.progress = toolUse?.name ? `running ${toolUse.name}` : "responding";
        if (s.metrics.activity !== "working") changed = true;
        s.metrics.activity = "working";
      } else {
        // Terminal per the transcript, but the session may still be draining a
        // background agent/workflow (the PTY spinner keeps ticking). Defer the
        // flip to "done"/"awaiting-choice" until the PTY falls silent; keep the
        // on-screen activity as-is ("working") until then. See scheduleSettle.
        s.pendingTerminal = raw;
        scheduleSettle(s);
      }
    }

    return changed;
  }

  function processChunk(s: SessionState, chunk: string): void {
    let changed = false;
    for (const raw of chunk.split("\n")) {
      const trimmed = raw.trim();
      if (trimmed) changed = processLine(s, trimmed) || changed;
    }
    if (changed) scheduleEmit(s);
  }

  function bindFile(s: SessionState, filePath: string): void {
    s.filePath = filePath;

    // Initial full read to catch up on existing transcript content
    try {
      const content = fs.readFileSync(filePath, "utf8");
      s.byteOffset = Buffer.byteLength(content, "utf8");
      processChunk(s, content);
    } catch {
      s.byteOffset = 0;
    }

    // Watch for appends; read only the newly-written bytes each time
    const watcher = chokidarWatch(filePath, { ignoreInitial: true, persistent: false });
    watcher.on("change", () => {
      try {
        const fd = fs.openSync(filePath, "r");
        const { size } = fs.fstatSync(fd);
        if (size <= s.byteOffset) {
          fs.closeSync(fd);
          return;
        }
        const len = size - s.byteOffset;
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, s.byteOffset);
        fs.closeSync(fd);
        s.byteOffset = size;
        processChunk(s, buf.toString("utf8"));
      } catch {
        // File disappeared or permission error — skip silently
      }
    });
    s.watcher = watcher;
  }

  return {
    track(meta: SessionMeta): void {
      let s = states.get(meta.id);
      if (!s) {
        s = {
          metrics: makeEmpty(meta.id),
          seen: new Set(),
          byteOffset: 0,
          filePath: null,
          watcher: null,
          debounceTimer: null,
          pendingTerminal: null,
          lastPtyAt: 0,
          settleTimer: null,
        };
        states.set(meta.id, s);
      }
      // Bind (or rebind, after /clear) the transcript once claudeSessionId is
      // known. sessions.ts rolls claudeSessionId to a new file on /clear; when the
      // resolved path changes, close the old watcher and follow the new file,
      // preserving the cumulative token totals for the session's whole lifetime.
      if (meta.claudeSessionId) {
        const fp = findTranscriptPath(meta.claudeSessionId, meta.cwd);
        if (fp && fp !== s.filePath) {
          if (s.watcher) {
            s.watcher.close().catch(() => undefined);
            s.watcher = null;
            s.byteOffset = 0;
            s.seen.clear(); // new file → new message ids; keep cumulative totals
          }
          bindFile(s, fp);
        }
      }
    },

    notePtyOutput(id: string): void {
      const s = states.get(id);
      if (!s) return;
      s.lastPtyAt = Date.now();
      // Fresh PTY output after a transcript-terminal ⇒ the session is still
      // working (a backgrounded agent/workflow is running its spinner). Flip
      // back to "working" if we'd tentatively quieted, and keep the settle loop
      // alive so we still land on the terminal state once the PTY finally stops.
      if (s.pendingTerminal) {
        if (s.metrics.activity !== "working") {
          s.metrics.activity = "working";
          s.metrics.progress = "responding";
          emitNow(s);
        }
        if (s.settleTimer === null) scheduleSettle(s);
      }
    },

    untrack(id: string): void {
      const s = states.get(id);
      if (!s) return;
      if (s.debounceTimer !== null) clearTimeout(s.debounceTimer);
      if (s.settleTimer !== null) clearTimeout(s.settleTimer);
      s.watcher?.close().catch(() => undefined);
      states.delete(id);
    },

    get(id: string): SessionMetrics | undefined {
      const s = states.get(id);
      return s ? snapshot(s) : undefined;
    },

    getAll(): SessionMetrics[] {
      return Array.from(states.values(), snapshot);
    },

    dispose(): void {
      for (const s of states.values()) {
        if (s.debounceTimer !== null) clearTimeout(s.debounceTimer);
        if (s.settleTimer !== null) clearTimeout(s.settleTimer);
        s.watcher?.close().catch(() => undefined);
      }
      states.clear();
    },
  };
}
