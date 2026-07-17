# Platforms

cc-deck targets **Windows 11** and **macOS** from a **single codebase**. There
are no OS-specific branches or forks — platform differences live behind a few
`process.platform` checks. Keep it that way: a fork is a codebase you can never
merge back.

## Support matrix

| Concern | Windows 11 | macOS |
|---|---|---|
| Session launch (node-pty) | `cmd.exe /d /s /c claude` (ConPTY) | `claude` directly |
| Process-tree teardown | `taskkill /F /T` | POSIX kill |
| Autostart | `.vbs` in the Startup folder | launchd LaunchAgent (`.plist`) |
| Claude paths | `os.homedir()/.claude` (no hardcoding) | same |
| **Status** | daily driver — **verified** | code written — **needs verification** |

The macOS paths are already implemented throughout; the risk is that they are
**unexercised** and can regress silently. CI (`.github/workflows/ci.yml`) builds
on both OSes to catch the compile/build class of breakage; the runtime behaviors
below still need a human on a Mac.

## Where the platform seams are

Touch these only with the matching OS on hand (or a reviewer who has it):

- **`server/sessions.ts`** — launch command (`isWin ? COMSPEC : "claude"`) and
  the win32 `taskkill` ConPTY reap. The macOS launch/kill path is written but
  unverified — this is the highest-risk seam.
- **`server/reports.ts`** — `detached` + kill differences for the report child.
- **`server/projects.ts`** — win32 slug branch.
- **`server/util.ts`** — `slugForCwd()` maps a cwd to its
  `~/.claude/projects/<slug>` dir by replacing every non-alphanumeric char with
  `-`. `findTranscriptPath()` also falls back to scanning every project dir, so a
  slug mismatch **degrades gracefully** (slower lookup) instead of showing 0
  tokens — but confirm the direct hit lands on macOS.
- **`scripts/install-autostart.mjs`** — already branches: win32 Startup-folder
  `.vbs` vs. macOS launchd `.plist` + `launchctl bootstrap`.
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
- [ ] **Statusline feed** — `npm run install:statusline`, then the account 5h/7d
      bars populate.
- [ ] **Autostart (optional)** — `npm run install:autostart` registers the
      launchd agent and it survives logout/login.

## Known footguns

**Windows**
- `claude` is a `.cmd` shim; ConPTY can't `CreateProcess` it directly (error 193,
  and it crashes the node-pty worker) — launch via `cmd.exe /d /s /c claude`.
- Strip inherited `CLAUDE_CODE*` / `CLAUDECODE` env so the child isn't treated
  as a nested session.

**macOS** — _fill in as you find them:_
- Kill the whole process group, not just the pty leader, or `claude` children may
  linger. _verify_
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
