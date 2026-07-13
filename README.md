# cc-deck

**Local mission-control for your [Claude Code](https://claude.com/claude-code) CLI sessions.**

One browser window to run several Claude Code sessions as real terminals side by
side, watch each one's live state and token/context usage at a glance, and keep
an eye on your account's 5-hour and weekly limits. Everything runs on your own
machine — cc-deck just reads what Claude Code already writes to `~/.claude`.

> **Not affiliated with Anthropic.** cc-deck reads local files and one
> undocumented account-usage endpoint; it may break when Claude Code changes,
> and degrades gracefully when it does.

## Features

- **Multi-session terminals** — open and switch between many `claude` sessions
  in one window. Real PTYs rendered with xterm.js, not a reimplementation — the
  same CLI underneath.
- **Per-session activity indicator** — each session shows 🟠 *working* /
  🔵 *awaiting choice* (a question or plan approval) / 🟢 *done*, derived live
  from its transcript.
- **Token & context metrics** — deduped cumulative tokens and context-window %
  per session.
- **Account usage** — 5-hour and weekly limit usage with reset times.
- **5 eye-friendly themes** — Midnight, Nord, Solarized Dark, Gruvbox,
  Solarized Light (top-right switcher; also themes the terminals).

## Requirements

- **Node 24+**
- **[Claude Code](https://claude.com/claude-code) CLI installed and logged in.**
  cc-deck is a control panel over your *own* local Claude Code, not a standalone
  app — it reads your `~/.claude`. Run `claude` once and sign in first so
  `~/.claude/.credentials.json` exists.
- **Windows or macOS** (Linux is untested but shares the non-Windows code path).

## Quick start

```bash
git clone https://github.com/Jayildo/cc-deck.git
cd cc-deck
npm install          # @lydell/node-pty ships prebuilds — no compiler needed
npm run build
npm start            # → http://localhost:4317
```

For development (backend + Vite with hot reload):

```bash
npm run dev          # backend :4317 + frontend :5273 → open http://localhost:5273
```

Optional helpers — `npm run install:autostart` starts cc-deck and opens the
dashboard on login; `npm run restart` relaunches it after you pull new code
(the server has no auto-reload). macOS-specific setup, autostart via launchd,
and troubleshooting live in **[MACOS.md](./MACOS.md)**.

## How it works / privacy

cc-deck binds to `127.0.0.1` behind a per-launch token — it is **loopback-only**
and talks to no third-party service. It reads what Claude Code already writes:

- `~/.claude/projects/**/<id>.jsonl` — transcripts → tokens, context %, activity
- `~/.claude/.credentials.json` — the OAuth token → account usage
- `~/.claude/sessions` — session metadata

Account usage has two sources (both on): an **OAuth poller** (accurate, works
with zero sessions open, undocumented — may break) and an optional **statusline
tee** (`npm run install:statusline`, reversible with `uninstall:statusline`)
that also feeds live statusline renders. Your existing statusline keeps working.

## Layout

```
shared/types.ts     WS protocol + data contract (shared by server & web)
server/             Fastify + node-pty backend
  index.ts          wiring: WS broadcast, auth, static serve
  sessions.ts       node-pty session manager (spawn/attach/resize/kill)
  metrics.ts        transcript tailer → tokens (deduped) + context % + activity
  usage.ts          OAuth poller + statusline-feed reader
web/                Vite + xterm.js frontend (plain TS, no framework)
scripts/            autostart / statusline install helpers (Windows + macOS)
```

## License

[MIT](./LICENSE) © 2026 Jayildo — free to use, modify, and redistribute with
attribution.
