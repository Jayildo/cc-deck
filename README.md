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
- **Per-session attention indicator** — each row shows 🟠 *working* /
  🔵 *awaiting choice* (a question or plan approval) / 🔴 *awaiting permission*
  (a tool-approval prompt) / 🟢 *done*. Working/choice/done come from the
  transcript (`stop_reason`), the permission state from the terminal itself; a
  row blinks when it needs you and stops once you select it. "Done" only shows
  after the terminal has actually gone quiet, so a background agent doesn't
  read as finished.
- **Token & context metrics** — deduped cumulative tokens and context-window %
  per session; restored immediately on reload/reconnect.
- **Account usage** — 5-hour and weekly limit usage with reset times.
- **Quick-pick & pinned tabs** — favorites/recents in the New Session picker,
  plus a row of pinned project tabs (private list in a git-ignored
  `web/src/quicktabs.local.ts`).
- **Paste / drop files** — clipboard images and OS drag-and-drop (≤ 11 MB) are
  saved to `~/.cc-deck/paste` and their path typed into the session.
- **Keyboard-first** — ⇧←/→ hops sessions, ⏎/Del act on the focused list row,
  Ctrl/⌥+⏎ inserts a newline, ⌥ word-editing works like a native terminal, and
  an always-visible ⌨ cheat-sheet lists the rest.
- **Daily work report** — 📋 gathers today's prompts, tools, files and commits per
  project and summarizes them with your own `claude -p` (auto at 23:30; see
  [privacy](#how-it-works--privacy)).
- **Connection badge** — a red "연결 끊김 — 재연결 중…" badge and dimmed terminal
  while the server is away; auto-reconnects every 3 s and re-attaches.
- **5 eye-friendly themes** — Midnight, Nord, Solarized Dark, Gruvbox,
  Solarized Light (top-right switcher; also themes the terminals).

## Requirements

- **Node 24+**
- **[Claude Code](https://claude.com/claude-code) CLI installed and logged in.**
  cc-deck is a control panel over your *own* local Claude Code, not a standalone
  app — it reads your `~/.claude`. Run `claude` once and sign in first so Claude
  Code has stored its OAuth token (`~/.claude/.credentials.json`, or the Keychain
  on macOS).
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

`npm install` also pulls devDependencies here even if your global npm config has
`omit=dev` — the repo's `.npmrc` sets `include=dev` because `build`/`typecheck`
need them.

Optional helpers — `npm run install:autostart` starts cc-deck hidden and opens
the dashboard on login (needs `npm run build` first). `npm run restart` stops the
server and relaunches it with whatever code is on disk (there is no auto-reload).
**Run it from a normal terminal, not from a session inside cc-deck — restarting
closes every hosted session.** On Windows it relaunches through the autostart
entry, so install that first. Frontend-only changes don't need a restart: `npm run
build` + reload the browser. macOS-specific setup, autostart via launchd, and
troubleshooting live in **[MACOS.md](./MACOS.md)**; the cross-platform rules and
seam list are in **[PLATFORMS.md](./PLATFORMS.md)**.

## How it works / privacy

cc-deck is **loopback-only**: it binds dual-stack so both `localhost` and
`127.0.0.1` work, and rejects any non-loopback peer — behind a per-launch token.

Network: it calls only Anthropic — `GET api.anthropic.com/api/oauth/usage` every
60 s with the OAuth token Claude Code already stores, and, for the daily report,
your own `claude -p` CLI (real API calls that count against your plan; auto-runs
once a day at 23:30 — set `CC_DECK_REPORT_TIME`, or generate on demand with 📋).

It reads what Claude Code already writes:

- `~/.claude/projects/**/<id>.jsonl` — transcripts → tokens, context %, activity
- `~/.claude/.credentials.json` (macOS: the login-Keychain item
  "Claude Code-credentials") — the OAuth token → account usage
- `~/.claude/sessions` — session metadata

It writes only to `~/.cc-deck/` (favorites, recents, reports, pasted files —
swept after 7 days, usage cache, optional statusline feed).

Account usage has two sources (both on): an **OAuth poller** (accurate, works
with zero sessions open, undocumented — may break) and an optional **statusline
tee** (`npm run install:statusline`, reversible with `uninstall:statusline`)
that also feeds live statusline renders. Your existing statusline keeps working.

## Layout

```
shared/types.ts     WS protocol + data contract (shared by server & web)
server/             Fastify + node-pty backend
  index.ts          wiring: WS broadcast, loopback guard, auth, paste/drop, static serve
  sessions.ts       node-pty session manager (spawn/attach/resize/kill), transcript
                    discovery, permission-prompt detection, exited-session TTL
  metrics.ts        transcript tailer → tokens (deduped) + context % + activity
  usage.ts          OAuth poller (+ macOS Keychain) + statusline-feed reader
  projects.ts       favorites / recents for the New Session picker
  reports.ts        daily work report (claude -p) + scheduler
  auth.ts / config.ts / util.ts
web/                Vite + xterm.js frontend (plain TS, no framework)
  src/              main ws terminal sessions usage projects quicktabs reports themes fmt
scripts/            autostart / statusline install helpers + restart (Windows + macOS)
.github/workflows/  CI: typecheck + build on windows-latest and macos-latest
```

## License

[MIT](./LICENSE) © 2026 Jayildo — free to use, modify, and redistribute with
attribution.
