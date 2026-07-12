import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as pty from "@lydell/node-pty";
import { config } from "./config.js";
import { slugForCwd, projectLabel } from "./util.js";
import type { SessionMeta, SessionManager, SessionManagerHandlers } from "../shared/types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 400;
const SLOW_POLL_MS = 3_000;
// Poll fast for this long after spawn (covers the common "first prompt within a
// few seconds" case), then slow down but NEVER stop while the pty is alive — the
// transcript is created lazily on the first submitted prompt, which can come much
// later, and /clear rolls the session id to a brand-new transcript mid-life.
const FAST_POLL_WINDOW_MS = 25_000;
const POLL_SKEW_MS = 2_000;

interface SessionEntry {
  meta: SessionMeta;
  terminal: ReturnType<typeof pty.spawn>;
  scrollback: string;
  discoveryTimer?: ReturnType<typeof setTimeout>;
  discoveryStopped?: boolean;
}

/** Trim scrollback to stay within the byte cap, dropping from the front. */
function trimScrollback(sb: string, cap: number): string {
  if (Buffer.byteLength(sb, "utf8") <= cap) return sb;
  const buf = Buffer.from(sb, "utf8");
  return buf.subarray(buf.length - cap).toString("utf8");
}

export function createSessionManager(handlers: SessionManagerHandlers): SessionManager {
  const sessions = new Map<string, SessionEntry>();

  function list(): SessionMeta[] {
    return [...sessions.values()].map((e) => e.meta);
  }

  function get(id: string): SessionMeta | undefined {
    return sessions.get(id)?.meta;
  }

  function attach(id: string): { meta: SessionMeta; scrollback: string } | null {
    const entry = sessions.get(id);
    if (!entry) return null;
    return { meta: entry.meta, scrollback: entry.scrollback };
  }

  function input(id: string, data: string): void {
    sessions.get(id)?.terminal.write(data);
  }

  function resize(id: string, cols: number, rows: number): void {
    sessions.get(id)?.terminal.resize(cols, rows);
  }

  function close(id: string): void {
    const entry = sessions.get(id);
    if (!entry) return;
    entry.discoveryStopped = true;
    clearTimeout(entry.discoveryTimer);
    const { pid } = entry.terminal;
    try { entry.terminal.kill(); } catch { /* already dead */ }
    // Reap the ConPTY process tree on Windows
    if (process.platform === "win32" && pid) {
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      } catch { /* best-effort */ }
    } else if (pid) {
      // node-pty's default kill() sends SIGHUP; a process that ignores or handles
      // it (or is mid-cleanup) can outlive the session. Force-kill as a
      // best-effort second pass — mirrors the win32 taskkill /F above.
      try {
        entry.terminal.kill("SIGKILL");
      } catch { /* already dead */ }
    }
    // User-initiated close: drop the entry so dead sessions don't pile up.
    // (Natural process exit keeps the entry marked "exited" for visibility.)
    sessions.delete(id);
    handlers.onSessions(list());
  }

  function dispose(): void {
    for (const id of sessions.keys()) close(id);
    sessions.clear();
  }

  async function open(cwd: string, opts?: { title?: string }): Promise<SessionMeta> {
    // Validate cwd up front: a bad path otherwise becomes an async ConPTY failure
    // (error 267) that node-pty rethrows from a worker thread, killing the server.
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`Cannot open session: directory not found: ${cwd}`);
    }

    const id = crypto.randomUUID();
    const spawnTime = Date.now();

    // ConPTY can only CreateProcess a real PE (.exe). On Windows `claude` is a
    // .cmd shim, so we launch it through the command processor — handing the shim
    // straight to ConPTY fails with "error 193 (bad exe format)" AND crashes the
    // server (node-pty rethrows from a worker thread, uncatchable here). Via
    // cmd.exe, claude.cmd resolves through PATHEXT and a missing binary degrades
    // to terminal output instead of a crash.
    const isWin = process.platform === "win32";
    const claudeFile = isWin ? (process.env.COMSPEC ?? "cmd.exe") : "claude";
    const claudeArgs = isWin ? ["/d", "/s", "/c", "claude"] : [];

    // Clean env: if cc-deck was itself launched from inside a Claude Code session,
    // the inherited CLAUDE_CODE* vars would make the child think it is nested.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE")) continue;
      childEnv[k] = v;
    }

    const terminal = pty.spawn(claudeFile, claudeArgs, {
      name: "xterm-256color",
      cols: config.defaultCols,
      rows: config.defaultRows,
      cwd,
      env: childEnv,
    });

    const meta: SessionMeta = {
      id,
      cwd,
      title: opts?.title ?? projectLabel(cwd),
      status: "starting",
      createdAt: spawnTime,
    };

    const entry: SessionEntry = { meta, terminal, scrollback: "" };
    sessions.set(id, entry);

    terminal.onData((data: string) => {
      if (entry.meta.status === "starting") entry.meta.status = "active";
      entry.scrollback = trimScrollback(entry.scrollback + data, config.scrollbackBytes);
      handlers.onData(id, data);
    });

    terminal.onExit(({ exitCode }) => {
      entry.discoveryStopped = true;
      clearTimeout(entry.discoveryTimer);
      entry.meta.status = "exited";
      handlers.onExit(id, exitCode ?? 0);
      handlers.onSessions(list());
    });

    // Let clients see the new session immediately
    handlers.onSessions(list());

    // Watch ~/.claude/projects/<slug>/ for this session's transcript. The .jsonl
    // is created lazily on the first submitted prompt (which may be well after
    // spawn), and /clear later rolls the session id to a new file — so we poll
    // fast for the first FAST_POLL_WINDOW_MS, then slowly forever while alive,
    // handling both initial discovery and rebinding.
    const projectDir = path.join(config.paths.projectsDir, slugForCwd(cwd));

    function scheduleDiscovery(): void {
      if (entry.discoveryStopped) return;
      const delay = Date.now() - spawnTime < FAST_POLL_WINDOW_MS ? POLL_MS : SLOW_POLL_MS;
      entry.discoveryTimer = setTimeout(() => void runDiscovery(), delay);
    }

    async function runDiscovery(): Promise<void> {
      if (entry.discoveryStopped || sessions.get(id) !== entry) return;

      let names: string[];
      try {
        names = await fsp.readdir(projectDir);
      } catch {
        scheduleDiscovery(); // directory may not exist yet
        return;
      }

      // Stat every candidate UUID transcript. birthtime is reliable on NTFS (the
      // target FS); fall back to mtime only when birthtime is unavailable (0).
      const candidates: { stem: string; birth: number; mtime: number }[] = [];
      for (const fname of names) {
        if (!fname.endsWith(".jsonl")) continue;
        const stem = fname.slice(0, -6);
        if (!UUID_RE.test(stem)) continue;
        try {
          const st = await fsp.stat(path.join(projectDir, fname));
          const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
          candidates.push({ stem, birth, mtime: st.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }

      // Recompute the claimed set SYNCHRONOUSLY here — after all awaits, right
      // before assignment — so two same-cwd pollers can't bind the same file.
      const claimed = new Set<string>();
      for (const e of sessions.values()) {
        if (e !== entry && e.meta.claudeSessionId) claimed.add(e.meta.claudeSessionId);
      }

      if (!entry.meta.claudeSessionId) {
        // Initial discovery: among unclaimed transcripts created at/after our
        // spawn, pick the one whose birthtime is CLOSEST to spawnTime so two
        // sessions opened in the same cwd don't swap transcripts.
        const eligible = candidates
          .filter((c) => !claimed.has(c.stem) && c.birth >= spawnTime - POLL_SKEW_MS)
          .sort((a, b) => Math.abs(a.birth - spawnTime) - Math.abs(b.birth - spawnTime));
        if (eligible[0]) {
          entry.meta.claudeSessionId = eligible[0].stem;
          entry.meta.pid = terminal.pid;
          handlers.onSessions(list());
        }
      } else {
        // Rebind: /clear starts a new session id + new transcript. If a strictly
        // newer unclaimed transcript than the bound one appears, switch to it so
        // metrics follow the live conversation instead of freezing on the old file.
        const bound = candidates.find((c) => c.stem === entry.meta.claudeSessionId);
        const boundBirth = bound?.birth ?? 0;
        const boundMtime = bound?.mtime ?? 0;
        const newer = candidates
          .filter(
            (c) =>
              c.stem !== entry.meta.claudeSessionId &&
              !claimed.has(c.stem) &&
              c.birth > boundBirth &&
              c.birth >= spawnTime - POLL_SKEW_MS &&
              // Only a /clear roll-over: the bound transcript went quiet at/before
              // the new one was born. A transcript still being appended (e.g. an
              // unrelated claude running in the same cwd) keeps a newer mtime and
              // is left alone, so we never hijack a live foreign session.
              boundMtime <= c.birth + POLL_SKEW_MS,
          )
          .sort((a, b) => b.birth - a.birth);
        if (newer[0]) {
          entry.meta.claudeSessionId = newer[0].stem;
          handlers.onSessions(list());
        }
      }

      scheduleDiscovery();
    }

    scheduleDiscovery();

    return meta;
  }

  return { open, attach, input, resize, close, list, get, dispose };
}
