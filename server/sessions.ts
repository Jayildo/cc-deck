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
// Exited rows stay visible this long (so the final output can still be read),
// then are evicted like a user × so memory / sidebar growth stays bounded.
const EXITED_TTL_MS = 30 * 60_000;
// Hysteresis: trim scrollback once per ~64 KB of new output instead of on every
// PTY event (a full re-encode of the 256 KB buffer costs ~1 ms per event at cap).
const SCROLLBACK_TRIM_AT = Math.floor(config.scrollbackBytes * 1.25);

interface SessionEntry {
  meta: SessionMeta;
  terminal: ReturnType<typeof pty.spawn>;
  scrollback: string;
  /** Approximate UTF-8 byte length of scrollback; resynced at every trim. */
  sbBytes: number;
  discoveryTimer?: ReturnType<typeof setTimeout>;
  evictTimer?: ReturnType<typeof setTimeout>;
  discoveryStopped?: boolean;
  /** ANSI-stripped tail of recent PTY output, used to detect the permission
   *  prompt. Reset when the user answers so stale prompt text can't re-trigger. */
  permClean: string;
  /** Ignore permission detection until this epoch-ms — a short window after the
   *  user answers, so the trailing redraw of the box doesn't re-arm the blink. */
  permSuppressUntil: number;
}

// Strip ANSI escape / OSC sequences so phrase matching sees plain text.
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;]*[A-Za-z@-~]/g;
// Size of the plain-text tail we keep for matching. Small enough that a dismissed
// prompt scrolls out quickly once real output resumes, big enough to hold the box.
const PERM_TAIL = 2000;
// Signatures unique to Claude Code's permission prompt. Any ONE match ⇒ the
// terminal is waiting for the user to approve a tool. Kept as short, stable
// substrings so word-wrap inside the box rarely splits them. (English — the CLI
// UI is English regardless of conversation language.)
const PERMISSION_RE =
  /Do you want to proceed|Do you want to make this edit|Do you want to create|don['’]t ask again|tell Claude what to do differently/;
// Structural backup — language-INDEPENDENT. A permission/choice prompt renders a
// selected numbered menu: "❯ 1. …" followed shortly by "2. …". This survives a
// future reword of the English prompt text (only the menu shape has to hold), so
// detection degrades gracefully instead of silently dying. It also matches plain
// choice menus (AskUserQuestion / plan) — the frontend keeps those labelled as
// "선택 요청" using the transcript, so the overlap is harmless. (The cursor glyph
// alone is a common shell prompt char, so we require the "❯ N." + "N." menu pair.)
// Claude Code renders the selected-row cursor as either ❯ (U+276F) or › (U+203A)
// depending on font/terminal — accept both, else the AskUserQuestion menu (which
// uses ›) slips past this backup detector.
const MENU_RE = /[❯›]\s*\d+\.[\s\S]{1,200}?\r?\n\s*\d+\.\s/;

/** Recompute a session's awaitingPermission from its recent output tail.
 *  Returns true if the flag flipped (caller should re-broadcast). */
function refreshPermission(entry: SessionEntry, now: number): boolean {
  const hit = PERMISSION_RE.test(entry.permClean) || MENU_RE.test(entry.permClean);
  const next = now >= entry.permSuppressUntil && hit;
  if (next === !!entry.meta.awaitingPermission) return false;
  entry.meta.awaitingPermission = next;
  return true;
}

/** Post-exit cleanup for node-pty's legacy conpty path (win32, no conptyDll):
 *  (1) it never destroys its conin socket — not even on kill() — so every
 *  self-exited session would leave a conhost.exe (~12 MB) alive for the server's
 *  lifetime; (2) a later kill() (× or TTL eviction, up to 30 min after exit) forks
 *  a console-list agent for the long-dead _innerPid and process.kill()s every
 *  member of whatever console that pid belongs to NOW — Windows reuses pids
 *  aggressively, so zero it: kill() then skips the sweep but still releases the
 *  HPCON and disposes the conout worker. Private fields; optional-chained so a
 *  rename in a future node-pty degrades to a no-op. */
function releaseConin(t: pty.IPty): void {
  if (process.platform !== "win32") return;
  try {
    const agent = (t as unknown as { _agent?: { _inSocket?: { destroy(): void }; _innerPid?: number } })._agent;
    agent?._inSocket?.destroy();
    if (agent && typeof agent._innerPid === "number") agent._innerPid = 0;
  } catch { /* best-effort */ }
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

  // Exited pty: node-pty throws on resize (would surface as an error toast every
  // time an exited row is selected) and silently drops writes — refuse both.
  function input(id: string, data: string): void {
    const entry = sessions.get(id);
    if (!entry || entry.meta.status === "exited") return;
    entry.terminal.write(data);
    // The user is answering (or otherwise interacting): drop the permission blink
    // immediately, wipe the stale prompt text so it can't re-trigger, and suppress
    // re-detection briefly to ride out the box's trailing redraw.
    entry.permClean = "";
    entry.permSuppressUntil = Date.now() + 700;
    if (entry.meta.awaitingPermission) {
      entry.meta.awaitingPermission = false;
      handlers.onSessions(list());
    }
  }

  function resize(id: string, cols: number, rows: number): void {
    const entry = sessions.get(id);
    if (!entry || entry.meta.status === "exited") return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 4096 || rows > 4096) return;
    entry.terminal.resize(cols, rows);
  }

  function close(id: string): void {
    const entry = sessions.get(id);
    if (!entry) return;
    entry.discoveryStopped = true;
    clearTimeout(entry.discoveryTimer);
    clearTimeout(entry.evictTimer);
    const { pid } = entry.terminal;
    // win32: kill() even on an exited pty — it releases the HPCON and stops the
    // conout worker thread (the console sweep is disarmed by releaseConin). POSIX:
    // nothing is left to release after exit and kill() would SIGHUP a possibly
    // reused pid, so skip it. Skip the process-tree reap when the process is
    // already gone (a synchronous taskkill against a dead pid is ~50 ms wasted).
    if (process.platform === "win32" || entry.meta.status !== "exited") {
      try { entry.terminal.kill(); } catch { /* already dead */ }
    }
    if (entry.meta.status !== "exited") {
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
    }
    // Drop the entry so dead sessions don't pile up (user ×, or the EXITED_TTL_MS
    // eviction after a natural exit).
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
    // macOS/Linux: launch claude through a LOGIN + INTERACTIVE shell
    // (`$SHELL -l -i -c claude`) rather than spawning "claude" directly. cc-deck may
    // run under launchd/systemd, whose parent process carries only a minimal PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin); spawning the bare binary then fails with
    // "ioctl(2) failed, EBADF" and the session exits immediately. A login+interactive
    // shell sources the user's profile (~/.zprofile, ~/.zshrc), restoring the real
    // PATH (~/.local/bin, Homebrew, …) and any `claude` shell function — mirroring how
    // the user opens claude in Terminal. If claude is still missing it degrades to a
    // terminal message instead of crashing the server.
    const isWin = process.platform === "win32";
    const claudeFile = isWin ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/zsh");
    const claudeArgs = isWin ? ["/d", "/s", "/c", "claude"] : ["-l", "-i", "-c", "claude"];

    // Clean env: if cc-deck was itself launched from inside a Claude Code session,
    // the inherited CLAUDE_CODE* vars would make the child think it is nested.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE")) continue;
      // The autostart launcher (run-server.cmd/.sh, `npm start`) sets
      // NODE_ENV=production for the server; leaked into hosted shells it makes
      // npm omit/prune devDependencies (and flips Vite/express into prod mode).
      // Only that value is ours to strip — a user's own NODE_ENV stays.
      if (k === "NODE_ENV" && v === "production") continue;
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

    const entry: SessionEntry = { meta, terminal, scrollback: "", sbBytes: 0, permClean: "", permSuppressUntil: 0 };
    sessions.set(id, entry);

    terminal.onData((data: string) => {
      if (entry.meta.status === "starting") entry.meta.status = "active";
      entry.scrollback += data;
      entry.sbBytes += Buffer.byteLength(data, "utf8");
      if (entry.sbBytes > SCROLLBACK_TRIM_AT) {
        // Cut on an LF (single-byte ASCII) just past the cap so the replayed
        // front never starts mid-UTF-8 char or mid-escape-sequence.
        const buf = Buffer.from(entry.scrollback, "utf8");
        let start = buf.length - config.scrollbackBytes;
        const nl = buf.indexOf(0x0a, start);
        if (nl !== -1 && nl - start <= 4096) start = nl + 1;
        entry.scrollback = buf.subarray(start).toString("utf8");
        entry.sbBytes = buf.length - start;
      }
      handlers.onData(id, data);

      // Permission-prompt detection: the prompt lives only in the PTY stream, so
      // scan a plain-text tail of recent output. Edge-triggered — only broadcast
      // when the awaitingPermission flag actually flips.
      entry.permClean = (entry.permClean + data.replace(ANSI_RE, "")).slice(-PERM_TAIL);
      if (refreshPermission(entry, Date.now())) handlers.onSessions(list());
    });

    terminal.onExit(({ exitCode }) => {
      releaseConin(entry.terminal);
      entry.discoveryStopped = true;
      clearTimeout(entry.discoveryTimer);
      entry.meta.status = "exited";
      handlers.onExit(id, exitCode ?? 0);
      handlers.onSessions(list());
      // Same teardown as × (HPCON release, map delete, broadcast) once the TTL runs out.
      entry.evictTimer = setTimeout(() => {
        if (sessions.get(id) === entry) close(id);
      }, EXITED_TTL_MS);
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
