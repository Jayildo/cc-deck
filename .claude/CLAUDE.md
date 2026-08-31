# cc-deck

Local mission-control for multiple Claude Code CLI sessions. One browser window:
open new sessions as **real terminals**, watch per-session progress, context-%,
and cumulative tokens, plus the account's **5h / weekly** usage. Runs entirely on
localhost; reads what Claude Code already writes. Windows 11 + macOS, single
codebase (see PLATFORMS.md / MACOS.md) / Node 24.

## Architecture (verified end-to-end 2026-06-30 · tree refreshed 2026-08-18)

```
shared/types.ts     WS protocol (ClientMsg/ServerMsg) + module interfaces — THE contract
server/
  config.ts         paths (~/.claude/*, ~/.cc-deck/*), port, reportTime, contextWindows, oauth endpoint
  util.ts           slugForCwd, findTranscriptPath, contextWindowFor, VERIFIED_CLAUDE_VERSION + bundle self-verify
  auth.ts           per-launch bearer token; WS Origin allow-list
  index.ts          Fastify + WS wiring; loopback guard; broadcasts; paste/drop files; report runner; static web/dist
  sessions.ts       node-pty manager: launch/attach/input/resize/close, transcript discovery, PERMISSION_RE/MENU_RE, exited TTL
  metrics.ts        transcript tailer → deduped tokens, context-%, activity (stop_reason + PTY-quiet settle)
  usage.ts          OAuth poller (+ macOS Keychain) + statusline-feed reader
  projects.ts       favorites/recents (~/.cc-deck/{favorites,recents}.json + ~/.claude recents)
  reports.ts        daily work report via `claude -p` + 23:30 scheduler → ~/.cc-deck/reports/
web/src/            Vite + xterm.js, plain TS: main ws terminal sessions usage projects quicktabs reports themes fmt
scripts/            install/uninstall-autostart, install/uninstall-statusline-tee, restart (all .mjs, typechecked)
.npmrc              include=dev (this machine's global npm has omit=dev)
```

Modules are built with a **handlers object** (callbacks) and wired in `index.ts`;
modules import only `config`/`util`, never each other. WS: ClientMsg open/attach/
input/pasteImage/dropFile/resize/close/refreshUsage/listProjects/addFavorite/
removeFavorite/listReports/getReport/generateReport · ServerMsg hello (carries a
`metrics` snapshot)/sessions/opened/projects/scrollback/pty/metrics/usage/exit/
reports/report/reportStatus/error — `pty`/`scrollback` are raw bytes ↔ xterm.js,
the rest structured. `SessionStatus` = starting | active | exited.

## Hard-won facts (don't relearn these)

- **PTY:** use `@lydell/node-pty` (N-API prebuilds; `@homebridge/...` has no Node-24
  prebuild and crashes). Launch claude via **`cmd.exe /d /s /c claude`** — ConPTY
  can't `CreateProcess` the `.cmd` shim directly (error 193) and node-pty rethrows
  that from a worker thread, killing the process. There's a `process.on('uncaughtException')`
  backstop in index.ts. macOS/Linux: `$SHELL -l -i -c claude` (launchd has a minimal
  PATH → bare `claude` dies with EBADF). Strip inherited `CLAUDE_CODE*`/`CLAUDECODE`
  env so the child isn't "nested", and `NODE_ENV=production` (only that value) so
  hosted shells don't prune devDependencies.
- **Exited sessions** stay listed 30 min (`EXITED_TTL_MS`) then go through the same
  teardown as ×. On win32 the conin socket is released and `_innerPid` zeroed at
  exit (conhost leak + PID-reuse kill sweep); `input()`/`resize()` ignore exited
  ptys; scrollback trims LF-aligned with hysteresis (`SCROLLBACK_TRIM_AT`).
- **Transcript is created lazily on the first submitted prompt**, not at startup —
  `claudeSessionId` discovery polls `projects/<slug>/*.jsonl` fast for 25s, then
  every 3s forever (also rebinds after `/clear`). A fresh idle session shows 0 tokens.
- **One record per content block, NOT a double-write.** Claude Code writes each
  assistant message as **several** JSONL records — one per content block
  (`thinking`, `text`, `tool_use`, one per parallel `tool_use`) — **all sharing the
  same `message.id`+`requestId`** and each repeating the full `usage`/`stop_reason`.
  - **Token dedup is mandatory:** count once per `message.id:requestId`, else ~Nx overcount.
  - **Activity is derived on every main-chain record, keyed off `stop_reason`**
    (`metrics.ts`): `stop_reason` ∈ DONE_REASONS (end_turn, stop_sequence,
    max_tokens, refusal, model_context_window_exceeded) → done; a `tool_use` block
    named in CHOICE_TOOLS (AskUserQuestion, ExitPlanMode) → awaiting-choice; anything
    else (tool_use / pause_turn / null mid-stream) → working. A genuine user prompt
    → working immediately. **"done" is deferred until the PTY has been quiet for
    SETTLE_MS (3s)** — a background agent writes nothing to the transcript but keeps
    the spinner ticking; `notePtyOutput` also flips an already-committed done back
    to working on fresh PTY bytes and re-arms the settle (a new turn spins before
    its first transcript line). awaiting-choice is immediate and left alone (its
    menu redraws the PTY).
  - **Split JSONL lines are reassembled** (`pendingBuf`, byte-level, 8MB cap): a
    big tool_use/thinking record arrives across several fs events, and a dropped
    line would freeze awaiting-choice/done. Tailer also resyncs when the file
    shrinks and always closes its fd (`finally`).
- **Permission prompts live only in the PTY** (`sessions.ts`): an ANSI-stripped 2KB
  tail is matched against `PERMISSION_RE` (5 English phrases: "Do you want to
  proceed / make this edit / create", "don't ask again", "tell Claude what to do
  differently") OR the language-independent `MENU_RE` ("❯|› 1." + "2." menu pair).
  `SessionMeta.awaitingPermission` → red **승인 대기**, blinks until acknowledged;
  any input clears it + 700ms re-detect suppression. Transcript-known choices
  (AskUserQuestion/plan) keep the blue 응답 필요.
- **Version watch (`util.ts`):** `VERIFIED_CLAUDE_VERSION` (2.1.234) is the CLI the
  phrases were last checked against by hand. The CLI auto-updates several times a
  week, so on mismatch the server **self-verifies at boot**: locates the CLI bundle
  (npm shim → `node_modules/@anthropic-ai/claude-code/bin/claude.exe`|`cli.js`, or
  native `~/.local/bin/claude`) and streams it for the PERMISSION_RE source
  fragments — all present → log only; missing/unlocatable → toast. Bumping the
  constant is optional hygiene. Detect via the server env (`%APPDATA%\npm` on
  Windows — an fnm/Git-Bash shim may show an older number).
- **Context-%** is the latest main-chain (`isSidechain !== true`) turn's
  `input+cache_read+cache_creation+output` ÷ window. `util.contextWindowFor` is
  generation-based: opus/sonnet major ≥5 or 4.≥6 → 1M; fable/mythos-N → 1M;
  haiku → 200K; `[1m]` → 1M; else 200K (`config.contextWindows`). The transcript
  records the raw API model id (date-suffixed legacy ids are guarded). Approximate;
  drops on `/compact`.
- **Account 5h/weekly:** primary = undocumented OAuth `GET /api/oauth/usage`
  (bearer from `~/.claude/.credentials.json` `claudeAiOauth.accessToken` — on macOS
  Claude Code keeps it in the login Keychain (service "Claude Code-credentials");
  usage.ts tries the file, then `security find-generic-password`; headers
  `anthropic-beta: oauth-2025-04-20`, User-Agent `claude-cli/<detected version>`).
  Real shape: `five_hour`/`seven_day` → `{utilization (direct %), resets_at (ISO)}`.
  **utilization is already 0..100 — never rescale.** Fetch has
  `AbortSignal.timeout(15s)`; `refreshNow()` coalesces overlapping calls, but the
  inflight slot is **deadline-capped (45s) + generation-guarded** — a fetch that
  wedged across sleep/wake never settled and froze the poller (and the 5H/7D bars)
  for 3 days (2026-08-18); non-ok bodies are cancelled to free the socket, and
  `get()` re-flags a >5-interval-old snapshot stale so a dead poller shows amber,
  not green. Fallback = statusline tee feed → stale cache, with diagnosis kept
  separate from data (`AuthNote: {error, needsLogin}`) so a degraded OAuth source
  still falls through to the fallback instead of shadowing it. Local-clock expiry
  → amber "토큰 만료" (self-heals once any `claude` session runs, not a real
  problem); a **2-strike** 401/403 → red "재로그인 필요" `needsLogin` (a one-off
  401 or a macOS Keychain prompt must never flash red); anything else (429/5xx,
  fetch throw) → amber with the specific reason. No automatic refresh — see
  "v2 / later".
- **Daily report** (`server/reports.ts`): at `config.reportTime` (default 23:30,
  `CC_DECK_REPORT_TIME`; scheduler ticks every 30s, once per day) and on the 📋
  button, gathers today's main-chain prompts/tools/files + git commits per project
  and runs `claude -p --model sonnet --output-format text` (≤10 projects, 120s
  timeout, process-tree kill via taskkill /T or process-group SIGKILL, same env
  scrub as sessions.ts) → `~/.cc-deck/reports/YYYY-MM-DD.md`. Uses account quota.
  Keep `SUMMARY_MODEL` as the CLI alias `"sonnet"` (latest Sonnet; decoupled from
  model churn), never a dated id.
- **Web:** `#conn-badge` + dimmed terminal while the WS is down (`ws.onConnectionStatus`,
  flat 3s retry); `hello.metrics` snapshot is applied on (re)connect so unselected
  rows aren't "대기/—" after a reload; attention blink (완료/응답 필요/승인 대기) is
  acknowledged by selecting the row; the session list is reconciled in place (no
  innerHTML rebuild — that reset every blink).

## Run

`npm run dev` (server 4317 + Vite 5273 → open http://localhost:5273) ·
`npm run build && npm start` (single process on 4317; `CC_DECK_PORT` to change) ·
`npm run install:autostart` (needs web/dist; hidden server + opens dashboard on login;
Windows also writes `~/.cc-deck/run-server.vbs` for tab-less restarts) ·
`npm run restart` = **server code only**, run it from an **EXTERNAL terminal** — it
kills every hosted session (memory: `cc-deck-restart-kills-hosting-session`);
web/* changes need only `npm run build` + browser reload · `npm run install:statusline`
(reversible). State lives in `~/.cc-deck/{favorites,recents,usage-cache}.json`,
`reports/`, `paste/` (7-day sweep), `statusline-feed.jsonl`; pinned tabs in
git-ignored `web/src/quicktabs.local.ts`. Deps: `npm install --include=dev` (or rely
on `.npmrc`); when package-lock moved but node_modules didn't, the restart window is
`npm install --include=dev --ignore-scripts && npm run typecheck && npm run build && npm run restart`.

## v2 / later

- `@lydell/node-pty` 1.2.0-beta.15 (Windows spawn/UAF/deadlock fixes) — native, so
  only in a restart window: `npm install @lydell/node-pty@1.2.0-beta.15` + restart.
- Date-aware report generation (then a scheduler catch-up after sleep makes sense).
- **Token-refresh automation** (`expiresAt` → `refreshToken`, preemptive) — reverse-engineered
  from the CLI 2.1.251 bundle but **not implemented**; keep these facts so a future session
  doesn't redo the reverse-engineering. TOKEN_URL `https://platform.claude.com/v1/oauth/token`,
  CLIENT_ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `POST {grant_type:"refresh_token",
  refresh_token, client_id, scope}`; a response with no `refresh_token` means reuse the one sent.
  On `invalid_grant` the **CLI** wipes disk `refreshToken`/`accessToken` to `""` and `expiresAt`
  to `0` — the reason this is unbuilt: a third party that consumes a refresh token and doesn't
  record what came back **logs the whole machine out**. Storage would need a CAS (write only if
  disk's `refreshToken` is still `""` or the value just posted); whether the server actually
  **rotates** the refresh token is unverified. Default scope list when credentials carry none:
  `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
  (use the credential file's own `scopes` when present). The CLI's own refresh takes a
  **mkdir-based** lock — dir name `.oauth_refresh.lock`, `EEXIST` = held — path **assumed**
  under `~/.claude/`, unconfirmed. A past-due `refreshTokenExpiresAt` means refresh itself is
  impossible; don't attempt one, only `/login` recovers it. The credentials file's top level
  also holds `mcpOAuth` beside `claudeAiOauth` — any write must preserve unknown top-level keys
  or it deletes the user's MCP credentials. If ever built: default OFF; refresh
  **preemptively** at `expiresAt − 5min`, never after expiry; disk write is temp+fsync+rename,
  never in-place; the macOS Keychain credential source stays untouched (file store only); a
  lock-acquire failure always means "skip this cycle", never steal the lock; `invalid_grant`
  never clears cc-deck's copy of the disk file.
- Read-only listing of sessions opened in the user's own terminals (`~/.claude/sessions/*.json`).
- Historical/aggregate dashboard over all transcripts (SQLite index).
- Optional `/api/token` Host-header check (FIX-PLAN 3.7; WS Origin check is the real gate).
