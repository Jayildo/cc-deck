# cc-deck

Local mission-control for your Claude Code CLI sessions. One window: open new
sessions as real terminals, watch per-session progress, context-window %, and
cumulative token usage, plus your account's **5-hour** and **weekly** limit
usage.

Everything runs on your machine, bound to `127.0.0.1` behind a per-launch token.
cc-deck reads what Claude Code already writes (`~/.claude/sessions`,
`~/.claude/projects/**/<id>.jsonl`, `~/.claude/.credentials.json`) — it does not
talk to any third-party service.

## Run

```bash
npm install
npm run dev      # backend (4317) + Vite frontend (5173) — open http://localhost:5173
```

Production (single process serving a built frontend):

```bash
npm run build
npm start        # open http://127.0.0.1:4317
```

## Account 5h / weekly usage

Two complementary sources (both enabled):

- **OAuth poller** — queries an undocumented Anthropic endpoint with the token
  already in `~/.claude/.credentials.json`. Accurate, works with zero sessions
  open, includes reset times. Unsupported — may break without notice; cc-deck
  degrades gracefully and shows a "source/stale" badge.
- **Statusline tee** _(optional)_ — `npm run install:statusline` wraps your
  existing Claude Code statusline so live renders also feed cc-deck. Reversible
  with `npm run uninstall:statusline`. Your current statusline keeps working.

## Layout

```
shared/types.ts     WS protocol + data contract (shared by server & web)
server/             Fastify + node-pty backend
  index.ts          wiring: WS broadcast, auth, static
  sessions.ts       node-pty session manager (spawn/attach/resize/kill)
  metrics.ts        transcript tailer → tokens (deduped) + context %
  usage.ts          OAuth poller + statusline-feed reader
web/                Vite + xterm.js frontend
scripts/            statusline tee install/uninstall
```
