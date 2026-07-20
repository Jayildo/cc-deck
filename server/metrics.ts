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
  /** A user prompt is a plain string; assistant blocks / tool results are arrays. */
  content?: TContent[] | string;
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

// The transcript tailer reads whatever bytes exist at each fs "change" event.
// A large record (a big AskUserQuestion tool_use, or a multi-KB thinking block —
// seen at 9KB+) is often flushed across several events, so a read can end in the
// MIDDLE of a JSON line. Without reassembly that partial line fails JSON.parse and
// is dropped, and byteOffset advances past it, losing it forever. Because the
// "awaiting-choice" state rides on a SINGLE line (and so does the end_turn that
// clears it), one dropped line freezes the row for the whole blocking window.
// So we buffer the un-terminated tail (as bytes — Korean menu text is multi-byte,
// so we must not decode across a line boundary) and only parse complete lines.
// See feedBytes / SessionState.pendingBuf. Cap the buffer so a never-terminated
// stream can't grow without bound (a real transcript line is well under this).
const MAX_PENDING = 8 * 1024 * 1024;

// ─── Per-session tracking state ───────────────────────────────────────────────

interface SessionState {
  metrics: SessionMetrics;
  /** Dedup keys: `${message.id ?? uuid}:${requestId ?? ""}` */
  seen: Set<string>;
  /** Byte offset into the transcript file (for incremental reads). */
  byteOffset: number;
  /** Un-terminated trailing bytes from the last read, prepended to the next read
   *  so a JSON line split across fs events is reassembled, not dropped. */
  pendingBuf: Buffer;
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

  /** True for a genuine user prompt (plain text), false for a tool_result echo. */
  function isUserPrompt(rec: TRecord): boolean {
    const content = rec.message?.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) return !content.some((c) => c.type === "tool_result");
    return false;
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

    // A freshly-submitted user prompt flips the session to "working" immediately,
    // closing the lag before Claude's first block record lands. It also cancels any
    // deferred terminal ("done"/"awaiting-choice") settle left over from the prior
    // turn (tool_result echoes and sidechain/subagent prompts are ignored).
    if (rec.type === "user" && rec.isSidechain !== true && isUserPrompt(rec)) {
      s.pendingTerminal = null;
      if (s.settleTimer !== null) {
        clearTimeout(s.settleTimer);
        s.settleTimer = null;
      }
      if (s.metrics.activity !== "working") {
        s.metrics.activity = "working";
        s.metrics.progress = "thinking";
        return true;
      }
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
      const content = rec.message?.content;
      const toolUse = Array.isArray(content)
        ? content.find((item) => item.type === "tool_use")
        : undefined;
      if (toolUse?.name) s.metrics.lastTool = toolUse.name;

      let raw: "working" | "awaiting-choice" | "done";
      if (stop && DONE_REASONS.has(stop)) {
        raw = "done"; // main-chain turn ended — but may still be waiting (see below)
      } else if (toolUse?.name && CHOICE_TOOLS.has(toolUse.name)) {
        raw = "awaiting-choice"; // AskUserQuestion / ExitPlanMode — user must pick
      } else {
        raw = "working"; // tool_use / pause_turn / null(mid-stream) = still working
      }

      if (raw === "working" || raw === "awaiting-choice") {
        // Both are immediate, unambiguous states — show now and cancel any
        // deferred terminal.
        //  • "working": a tool is running / mid-stream.
        //  • "awaiting-choice": Claude is BLOCKED on an AskUserQuestion/ExitPlanMode
        //    modal and cannot proceed until the user picks. It must NOT go through
        //    the PTY-silence settle: that gate exists only to avoid a false "완료"
        //    while a background agent's spinner keeps the PTY ticking. A pending
        //    choice has no such ambiguity, and its own interactive menu keeps the
        //    PTY busy — routing it through settle pinned the row to "작동 중" forever
        //    (it never settled). See notePtyOutput.
        s.pendingTerminal = null;
        if (s.settleTimer !== null) {
          clearTimeout(s.settleTimer);
          s.settleTimer = null;
        }
        s.metrics.progress =
          raw === "awaiting-choice"
            ? "awaiting choice"
            : toolUse?.name
              ? `running ${toolUse.name}`
              : "responding";
        if (s.metrics.activity !== raw) changed = true;
        s.metrics.activity = raw;
      } else {
        // raw === "done": the transcript says the turn ended, but the session may
        // still be draining a background agent/workflow (the PTY spinner keeps
        // ticking). Defer the flip to "done" until the PTY falls silent; keep the
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

  // Reassemble complete lines across reads before parsing. Prepend any leftover
  // partial line, process everything up to the last newline, and stash the
  // remainder for next time. Byte-level so a multi-byte char split across the
  // read boundary isn't corrupted. See MAX_PENDING / pendingBuf.
  function feedBytes(s: SessionState, buf: Buffer): void {
    const combined = s.pendingBuf.length ? Buffer.concat([s.pendingBuf, buf]) : buf;
    const lastNL = combined.lastIndexOf(0x0a);
    if (lastNL === -1) {
      // No complete line yet — keep buffering (unless it's grown absurdly large,
      // which means the stream is malformed; drop it rather than leak memory).
      s.pendingBuf = combined.length > MAX_PENDING ? Buffer.alloc(0) : Buffer.from(combined);
      return;
    }
    const remainder = combined.subarray(lastNL + 1);
    s.pendingBuf = remainder.length ? Buffer.from(remainder) : Buffer.alloc(0);
    processChunk(s, combined.subarray(0, lastNL + 1).toString("utf8"));
  }

  function bindFile(s: SessionState, filePath: string): void {
    s.filePath = filePath;

    // Initial full read to catch up on existing transcript content
    try {
      const buf = fs.readFileSync(filePath);
      s.byteOffset = buf.length;
      feedBytes(s, buf);
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
        feedBytes(s, buf);
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
          pendingBuf: Buffer.alloc(0),
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
            s.pendingBuf = Buffer.alloc(0); // new file → drop any half-read tail
            s.seen.clear(); // new file → new message ids; keep cumulative totals
            // The prior turn's live activity belongs to the OLD transcript; a
            // /clear-rolled session must not inherit it. Reset to a clean idle
            // baseline (and drop any deferred terminal) so a stale "working" /
            // "awaiting-choice" / pending-"done" can't ride across the roll. (The
            // brief pre-first-prompt window still self-heals at the next prompt via
            // the user-prompt → working handler; there is no /clear event to hook.)
            if (s.settleTimer !== null) {
              clearTimeout(s.settleTimer);
              s.settleTimer = null;
            }
            s.pendingTerminal = null;
            s.metrics.activity = undefined;
            s.metrics.progress = "idle";
          }
          bindFile(s, fp);
        }
      }
    },

    notePtyOutput(id: string): void {
      const s = states.get(id);
      if (!s) return;
      s.lastPtyAt = Date.now();
      // Fresh PTY output ⇒ the session is doing something RIGHT NOW. Two stale
      // on-screen states must flip back to "working":
      //   • mid-settle (pendingTerminal set): a backgrounded agent/workflow spinner
      //     is still ticking after a transcript-terminal — defer the flip as before.
      //   • already-committed "done": a NEW turn's spinner just started. An idle
      //     Claude prompt emits NO PTY bytes, so output here is real new activity —
      //     but the prior fix gated this out, pinning the row to "완료" while Claude
      //     was visibly working (e.g. a 43s "Crunched" think before the first
      //     transcript line). Re-arm a "done" settle so a stray late byte still
      //     falls back to "완료" once the PTY quiets again.
      // "awaiting-choice" is deliberately left alone: its interactive menu redraws
      // the PTY while the user is still picking, and must stay "선택 요청".
      if (s.pendingTerminal === null && s.metrics.activity === "done") {
        s.pendingTerminal = "done";
      }
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
