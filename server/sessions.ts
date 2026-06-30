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
const POLL_TIMEOUT_MS = 25_000;
const POLL_SKEW_MS = 2_000;

interface SessionEntry {
  meta: SessionMeta;
  terminal: ReturnType<typeof pty.spawn>;
  scrollback: string;
  discoveryTimer?: ReturnType<typeof setInterval>;
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
    clearInterval(entry.discoveryTimer);
    const { pid } = entry.terminal;
    try { entry.terminal.kill(); } catch { /* already dead */ }
    // Reap the ConPTY process tree on Windows
    if (process.platform === "win32" && pid) {
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      } catch { /* best-effort */ }
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
      clearInterval(entry.discoveryTimer);
      entry.meta.status = "exited";
      handlers.onExit(id, exitCode ?? 0);
      handlers.onSessions(list());
    });

    // Let clients see the new session immediately
    handlers.onSessions(list());

    // Poll ~/.claude/projects/<slug>/ for a new *.jsonl whose stem is a UUID
    // and whose file time is >= spawnTime (with a small skew for filesystem lag).
    const projectDir = path.join(config.paths.projectsDir, slugForCwd(cwd));
    let elapsed = 0;

    entry.discoveryTimer = setInterval(async () => {
      elapsed += POLL_MS;

      if (entry.meta.claudeSessionId || elapsed > POLL_TIMEOUT_MS) {
        clearInterval(entry.discoveryTimer);
        return;
      }

      let names: string[];
      try {
        names = await fsp.readdir(projectDir);
      } catch {
        return; // directory may not exist yet; keep trying
      }

      // Collect claudeSessionIds already claimed by other tracked sessions
      const claimed = new Set<string>();
      for (const e of sessions.values()) {
        if (e.meta.id !== id && e.meta.claudeSessionId) claimed.add(e.meta.claudeSessionId);
      }

      for (const fname of names) {
        if (!fname.endsWith(".jsonl")) continue;
        const stem = fname.slice(0, -6);
        if (!UUID_RE.test(stem)) continue;
        if (claimed.has(stem)) continue;

        try {
          const st = await fsp.stat(path.join(projectDir, fname));
          // Use whichever timestamp is later (birthtimeMs may be 0 on some FSes)
          const fileTime = Math.max(st.birthtimeMs, st.mtimeMs);
          if (fileTime < spawnTime - POLL_SKEW_MS) continue;
        } catch {
          continue;
        }

        entry.meta.claudeSessionId = stem;
        entry.meta.pid = terminal.pid;
        clearInterval(entry.discoveryTimer);
        handlers.onSessions(list());
        return;
      }
    }, POLL_MS);

    return meta;
  }

  return { open, attach, input, resize, close, list, get, dispose };
}
