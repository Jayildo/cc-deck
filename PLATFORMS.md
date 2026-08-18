# Platforms

cc-deck targets **Windows 11** and **macOS** from a **single codebase**. There
are no OS-specific branches or forks — platform differences live behind a few
`process.platform` checks. Keep it that way: a fork is a codebase you can never
merge back.

## Support matrix

| Concern | Windows 11 | macOS |
|---|---|---|
| Session launch (node-pty) | `cmd.exe /d /s /c claude` (ConPTY) | `$SHELL -l -i -c claude` (login + interactive shell, so launchd's minimal PATH still finds `claude`) |
| Process-tree teardown | `taskkill /F /T`; conin socket released at exit | node-pty `kill()` (SIGHUP) + SIGKILL second pass |
| OAuth credentials | `~/.claude/.credentials.json` | file first, then `security find-generic-password -s "Claude Code-credentials" -w` |
| Autostart | `.vbs` in the Startup folder (+ `~/.cc-deck/run-server.vbs` for restarts) | launchd LaunchAgent (`.plist`) |
| Restart (`npm run restart`) | netstat → taskkill → relaunch via `.vbs` | `lsof -ti tcp:PORT -sTCP:LISTEN` → kill all listeners → `launchctl kickstart` or detached spawn |
| Claude paths | `os.homedir()/.claude` (no hardcoding) | same |
| **Status** | daily driver — **verified** | exercised by the macOS collaborator (2026-07-17: login-shell launch, Keychain usage, launchd fixes — merged in b9a0f7b); re-run the checklist below after each seam change |

The macOS paths have been exercised once end-to-end but remain **lightly
tested** and can regress silently. CI (`.github/workflows/ci.yml`) builds on both
OSes to catch the compile/build class of breakage; the runtime behaviors below
still need a human on a Mac after each seam change.

## Where the platform seams are

Touch these only with the matching OS on hand (or a reviewer who has it):

- **`server/sessions.ts`** — both launch forms (`COMSPEC /d /s /c claude` vs
  `$SHELL -l -i -c claude`), the win32 `taskkill` ConPTY reap + `releaseConin`
  vs the POSIX SIGHUP+SIGKILL teardown. Highest-risk seam.
- **`server/reports.ts`** — `detached` + kill differences for the report child
  (`taskkill /T` vs process-group SIGKILL); `normPath` lowercases on win32 only.
- **`server/projects.ts`** — `normKey` case-folds + backslash-normalizes on win32
  only (macOS paths are case-sensitive — never lowercase there).
- **`server/usage.ts`** — macOS Keychain fallback for the OAuth token.
- **`server/util.ts`** — `slugForCwd()` maps a cwd to its
  `~/.claude/projects/<slug>` dir by replacing every non-alphanumeric char with
  `-`. `findTranscriptPath()` also falls back to scanning every project dir, so a
  slug mismatch **degrades gracefully** (slower lookup) instead of showing 0
  tokens — but confirm the direct hit lands on macOS. `detectClaudeVersion()` /
  `locateClaudeBundle()` mirror the launch shell (`cmd.exe` vs `$SHELL -l -i`)
  and know both install layouts (npm shim → `node_modules/@anthropic-ai/claude-code`,
  native `~/.local/bin/claude`).
- **`scripts/install-autostart.mjs`** / **`scripts/restart.mjs`** — win32
  Startup-folder `.vbs` vs macOS launchd `.plist` + `launchctl bootstrap`;
  restart resolves the port from `CC_DECK_PORT` or the written launcher.
- **`server/config.ts`** — every Claude path derives from `os.homedir()/.claude`,
  correct on both OSes.

## macOS first-run checklist (collaborator)

`npm install && npm run dev`, open http://localhost:5273, then verify:

- [ ] **Session launches** — "+ New Session" spawns a real `claude` TUI. (No
      ConPTY / error 193 concerns — those are Windows-only.)
- [ ] **Transcript resolves** — after sending one prompt, the session shows
      non-zero tokens + context-%. If it stays 0, the `slugForCwd` direct hit
      missed: compare against the real dir name under `~/.claude/projects/`.
- [ ] **Clean teardown** — closing a session (Del) leaves no orphaned
      `claude` / node processes (`ps aux | grep -i claude`).
- [ ] **Account usage** — 5h/7d bars populate from the Keychain token (no
      `.credentials.json` on macOS); optionally `npm run install:statusline`.
- [ ] **Autostart (optional)** — `npm run install:autostart` registers the
      launchd agent and it survives logout/login.

## Known footguns

**Windows**
- `claude` is a `.cmd` shim; ConPTY can't `CreateProcess` it directly (error 193,
  and it crashes the node-pty worker) — launch via `cmd.exe /d /s /c claude`.
- Strip inherited `CLAUDE_CODE*` / `CLAUDECODE` env so the child isn't treated
  as a nested session; strip `NODE_ENV=production` (only that value) so hosted
  shells don't prune devDependencies.
- The CLI auto-updates in `%APPDATA%\npm`; an fnm/Git-Bash shim can shadow it
  with an older version — the server detects the version through `cmd.exe`.
- node-pty's legacy conpty path never closes its conin socket — released by hand
  at exit (`releaseConin`), else one conhost.exe per exited session lingers.

**macOS**
- The OAuth token is in the login **Keychain** ("Claude Code-credentials"), not
  `~/.claude/.credentials.json` — usage.ts falls back to `security
  find-generic-password`. Under launchd the first read may prompt for Keychain
  access.
- launchd hands the server a minimal PATH; spawning bare `claude` fails with
  `ioctl(2) failed, EBADF` and the session exits at once — always launch via
  `$SHELL -l -i -c claude`.
- Kill the whole process group, not just the pty leader, or `claude` children may
  linger (reports.ts uses `detached` + `process.kill(-pid)`).
- `@lydell/node-pty` needs a `darwin-arm64` (Apple Silicon) N-API prebuild.
  _verify `npm ci` on an M-series machine_
- `launchctl bootstrap` domain is `gui/$(id -u)`. _verify the agent loads_

## Rules for cross-platform code

1. Never hardcode `C:\`, a leading `/`, or a path separator — use `path.join` /
   `path.sep`.
2. Anchor Claude paths on `os.homedir()`, never a literal home directory.
3. New OS-specific behavior goes behind `process.platform` in the seam files
   above, and you write the other platform's branch at the same time (stub it if
   you can't test it, and add it to the checklist).
4. Line endings are normalized to LF by `.gitattributes`. Don't fight it; don't
   commit CRLF.
