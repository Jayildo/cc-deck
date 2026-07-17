# cc-deck

Local mission-control for multiple Claude Code CLI sessions. One browser window:
open new sessions as **real terminals**, watch per-session progress, context-%,
and cumulative tokens, plus the account's **5h / weekly** usage. Runs entirely on
localhost; reads what Claude Code already writes. Windows 11 / Node 24.

## Architecture (verified end-to-end 2026-06-30)

```
shared/types.ts   WS protocol (ClientMsg/ServerMsg) + module interfaces — THE contract
server/
  config.ts       paths (~/.claude/{sessions,projects,.credentials.json}), ports, oauth endpoint
  util.ts         slugForCwd (non-alnum → "-"), findTranscriptPath (glob <sessionId>.jsonl), labels
  auth.ts         per-launch bearer token; WS Origin allow-list
  index.ts        Fastify + @fastify/websocket wiring; broadcasts; static serve of web/dist
  sessions.ts     node-pty session manager (createSessionManager)
  metrics.ts      transcript tailer → deduped tokens + context-% (createMetricsEngine)
  usage.ts        OAuth poller + statusline-feed reader (createUsagePoller)
web/              Vite + xterm.js frontend (plain TS, no framework)
scripts/          install/uninstall-statusline-tee.mjs (opt-in, non-destructive)
```

Modules are built with a **handlers object** (callbacks) and wired in `index.ts`;
no module imports another. Two WS channels: `pty` (raw bytes ↔ xterm.js) and
`metrics`/`usage`/`sessions` (structured).

## Hard-won facts (don't relearn these)

- **PTY:** use `@lydell/node-pty` (N-API prebuilds; `@homebridge/...` has no Node-24
  prebuild and crashes). Launch claude via **`cmd.exe /d /s /c claude`** — ConPTY
  can't `CreateProcess` the `.cmd` shim directly (error 193) and node-pty rethrows
  that from a worker thread, killing the process. There's a `process.on('uncaughtException')`
  backstop in index.ts. Strip inherited `CLAUDE_CODE*` env so the child isn't "nested".
- **Transcript is created lazily on the first submitted prompt**, not at startup —
  so `claudeSessionId` discovery (polling `projects/<slug>/*.jsonl`) only resolves
  after the user sends a message. A fresh idle session correctly shows 0 tokens.
- **One record per content block, NOT a double-write.** Claude Code writes each
  assistant message as **several** JSONL records — one per content block
  (`thinking`, `text`, `tool_use`, and one per parallel `tool_use`) — **all sharing
  the same `message.id`+`requestId`** and each repeating the full message `usage`
  and `stop_reason`. (The old "written twice ~16s apart" note was a misread: the
  gap was the thinking→tool_use block gap within one message.)
  - **Token dedup is mandatory:** count once per `message.id:requestId`, else ~Nx
    overcount (N = block count).
  - **Activity must NOT be gated by that dedup.** Deriving activity from only the
    first-seen block (usually `thinking`) drops the `tool_use` block → "working"/
    "awaiting-choice" never show. `metrics.ts` derives activity on **every**
    main-chain record (last wins): `tool_use` block name → working /
    awaiting-choice (CHOICE_TOOLS); else `stop_reason==="tool_use"` → working,
    `end_turn`/etc → done. A genuine (non-tool_result) `user` record → working
    immediately, to kill the pre-first-token lag.
- **Context-%** is the latest main-chain (`isSidechain !== true`) turn's
  `input+cache_read+cache_creation+output` ÷ window (1M for `[1m]`/opus-4.6/sonnet-4.6,
  else 200K). Approximate; drops on `/compact`.
- **Account 5h/weekly:** primary = undocumented OAuth `GET /api/oauth/usage`
  (bearer from `~/.claude/.credentials.json` `claudeAiOauth.accessToken`; headers
  `anthropic-beta: oauth-2025-04-20`). Real shape: `five_hour`/`seven_day` →
  `{utilization (direct %), resets_at (ISO)}`. **utilization is already 0..100 — never rescale.**
  Fallback = statusline tee feed. Expired token → "reauth needed" (no refresh in v1).

## Run

`npm run dev` (server 4317 + Vite 5273 → open http://localhost:5273) ·
`npm run build && npm start` (single process on 4317). ·
`npm run install:statusline` to enable the live statusline feed (reversible).

## v2 / later

- Read-only listing of sessions opened in the user's own terminals (from `~/.claude/sessions/*.json`).
- Token-refresh automation (`expiresAt` → `refreshToken`).
- Historical/aggregate dashboard over all transcripts (SQLite index).
- Partial-JSONL-line buffering in the metrics tailer; reconnect UX in the frontend.
