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
  /** Message-level end reason, repeated on every block record of the message:
   *  "tool_use" (a tool call is / will be in this message), "end_turn" (the turn
   *  is finished), "max_tokens" / "stop_sequence", or null mid-stream. */
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

  /** True for a genuine user prompt (plain text), false for a tool_result echo. */
  function isUserPrompt(rec: TRecord): boolean {
    const content = rec.message?.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) return !content.some((c) => c.type === "tool_result");
    return false;
  }

  /**
   * Live activity implied by a single assistant record. Claude Code writes ONE
   * record per content block (thinking / text / tool_use), all sharing the same
   * message.id+requestId, and every block carries the message-level `stop_reason`.
   * So we can read intent from any block: `stop_reason === "tool_use"` means a
   * tool call is (or will be) part of this message; the tool_use block itself
   * carries the name that separates "working" from "awaiting-choice".
   */
  function activityOf(rec: TRecord): {
    activity: NonNullable<SessionMetrics["activity"]>;
    tool?: string;
    progress: string;
  } {
    const content = rec.message?.content;
    const toolUse = Array.isArray(content) ? content.find((c) => c.type === "tool_use") : undefined;
    if (toolUse?.name) {
      return CHOICE_TOOLS.has(toolUse.name)
        ? { activity: "awaiting-choice", tool: toolUse.name, progress: `awaiting ${toolUse.name}` }
        : { activity: "working", tool: toolUse.name, progress: `running ${toolUse.name}` };
    }
    // A thinking / text block: lean on the message-level stop_reason to know
    // whether a tool call is still coming ("tool_use") or the turn is ending.
    if (rec.message?.stop_reason === "tool_use") return { activity: "working", progress: "working" };
    return { activity: "done", progress: "responding" };
  }

  /**
   * Parse one JSONL line and mutate state. Returns true if anything the frontend
   * cares about (activity or token totals) changed, so an emit should be scheduled.
   *
   * Activity and token accounting are DELIBERATELY decoupled: activity is derived
   * from EVERY main-chain assistant record (last one wins = the live state), while
   * tokens/context/turnCount are counted once per message id. Gating activity on
   * the token dedup was the old bug — it kept only the first block (usually
   * `thinking`) and dropped the `tool_use`, so "working"/"awaiting-choice" never
   * showed.
   */
  function processLine(s: SessionState, raw: string): boolean {
    let rec: TRecord;
    try {
      rec = JSON.parse(raw) as TRecord;
    } catch {
      return false;
    }

    // A freshly-submitted user prompt flips the session to "working" immediately,
    // closing the lag before Claude's first block record lands (tool_result echoes
    // and sidechain/subagent prompts are ignored).
    if (rec.type === "user" && rec.isSidechain !== true && isUserPrompt(rec)) {
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

    let changed = false;

    // ── Activity — every main-chain record, NOT gated by the token dedup below.
    if (rec.isSidechain !== true) {
      const a = activityOf(rec);
      if (s.metrics.activity !== a.activity || s.metrics.progress !== a.progress) {
        s.metrics.activity = a.activity;
        s.metrics.progress = a.progress;
        changed = true;
      }
      if (a.tool && s.metrics.lastTool !== a.tool) {
        s.metrics.lastTool = a.tool;
        changed = true;
      }
    }

    // ── Tokens / context / turn count — once per message id. Each block record
    // repeats the full message usage, so the (id:req) dedup counts it exactly once.
    const msgId = rec.message?.id ?? rec.uuid ?? "";
    const reqId = rec.requestId ?? "";
    const key = `${msgId}:${reqId}`;
    if (!s.seen.has(key)) {
      s.seen.add(key);

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

      const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      s.metrics.lastActivity = isNaN(ts) ? Date.now() : ts;
      s.metrics.turnCount++;
      changed = true;
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

    untrack(id: string): void {
      const s = states.get(id);
      if (!s) return;
      if (s.debounceTimer !== null) clearTimeout(s.debounceTimer);
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
        s.watcher?.close().catch(() => undefined);
      }
      states.clear();
    },
  };
}
