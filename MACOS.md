# cc-deck on macOS

From-zero setup for running cc-deck on macOS. Everything below is local — cc-deck
runs entirely on your machine, loopback-only (localhost / 127.0.0.1 — non-loopback
peers are rejected).

## Prerequisites

- **Node 24+** — `brew install node`, or via nvm/fnm. Verify: `node -v`.
- **git**.
- **Your own Claude Code CLI, installed and logged in.** cc-deck is a dashboard
  for the sessions and account data Claude Code already writes to `~/.claude` —
  it is not a standalone app and does not ship or manage credentials. If you
  haven't already: `npm install -g @anthropic-ai/claude-code`, then run `claude`
  once and complete login. cc-deck reads:
  - `~/.claude/sessions/*.json` (your recent sessions)
  - `~/.claude/projects/**/<id>.jsonl` (transcripts, for tokens + context %)
  - the OAuth token, from `~/.claude/.credentials.json` if present, otherwise the
    login-Keychain item "Claude Code-credentials" (for account 5h/weekly usage)

## Install

```bash
git clone <this-repo-url> cc-deck
cd cc-deck
npm install
```

`@lydell/node-pty` ships a prebuilt macOS binary, so this normally installs
without needing Xcode Command Line Tools or a compiler. If `npm install` ever
falls back to building from source, install the Xcode CLT first:
`xcode-select --install`.

## Run

Development (hot-reloading server + Vite frontend):

```bash
npm run dev      # backend (4317) + Vite frontend (5273) — open http://localhost:5273
```

Production (single process serving the built frontend):

```bash
npm run build
npm start        # open http://127.0.0.1:4317
```

## Autostart on login (optional)

Installs a launchd LaunchAgent that starts the production server when you log
in and opens the dashboard in your browser once it's ready.

```bash
npm run build            # required first — production serves the built frontend
npm run install:autostart
```

This writes:

- `~/.cc-deck/run-server.sh` — starts the server (`NODE_ENV=production`)
- `~/.cc-deck/open-dashboard.sh` — waits for `/api/health`, then opens the dashboard
- `~/Library/LaunchAgents/com.ccdeck.dashboard.plist` — the LaunchAgent, loaded
  immediately via `launchctl bootstrap`

Remove it with:

```bash
npm run uninstall:autostart
```

This unloads the LaunchAgent (`launchctl bootout`) and deletes the plist. The
launcher scripts in `~/.cc-deck` are left in place.

## Restart after a code change

The autostart server doesn't hot-reload. After pulling or editing server code:

```bash
npm run restart
```

This stops every listener on the port (`lsof -ti tcp:PORT -sTCP:LISTEN` + `kill`;
the port comes from `CC_DECK_PORT` or the launcher `install:autostart` wrote), then
relaunches it — via `launchctl kickstart` if the LaunchAgent is installed,
otherwise by spawning the server detached.

**Restart from Terminal, not from a session inside cc-deck — it closes every
hosted session.** Frontend-only changes need just `npm run build` + a browser
reload.

## Pinned project tabs (optional)

The tab row across the top opens a fresh session in a pinned folder. Keep your
own list out of git:

```bash
cp web/src/quicktabs.local.example.ts web/src/quicktabs.local.ts   # git-ignored
# edit paths/labels, then
npm run build
```

## Statusline tee (optional)

Wraps your existing Claude Code statusline so live renders also feed cc-deck's
account-usage view, without polling the OAuth endpoint every cycle:

```bash
npm run install:statusline    # reversible
npm run uninstall:statusline  # restores your original statusLine.command
```

Your current statusline keeps working — cc-deck's wrapper pipes the same input
through to it unchanged.

## Troubleshooting

- **Port already in use** — something else is bound to 4317 (or your
  `CC_DECK_PORT`). Run `npm run restart`, or `lsof -ti tcp:4317 | xargs kill -9`
  and start again.
- **node-pty fails to load / build error** — you're likely on an unusual
  architecture or Node version. Confirm `node -v` is 24+, then
  `rm -rf node_modules && npm install`. If it tries to compile, run
  `xcode-select --install` first.
- **Account usage shows "reauth needed" / sessions list is empty** — either
  you're not logged into Claude Code on this machine yet, or the Keychain item
  "Claude Code-credentials" can't be read by the server. Run `claude` in a
  terminal and complete login; if macOS prompts for Keychain access when cc-deck
  runs under launchd, allow it. cc-deck only reads the token (file, then
  Keychain) and never manages auth itself.
- **`launchctl bootstrap` fails during `install:autostart`** — usually means a
  stale copy is already loaded. The installer already runs `bootout` first, but
  if it still fails, run manually: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ccdeck.dashboard.plist`,
  then re-run `npm run install:autostart`.
