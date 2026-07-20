import "@xterm/xterm/css/xterm.css";
import "../style.css";

import type { ServerMsg, SessionMetrics, SessionMeta } from "../../shared/types";
import { connect, onMessage, send } from "./ws.js";
import { initTerminalContainer, write, activate, getActiveId, disposeTerminal, terminalIds, focusTerminal, resetTerminal, setTerminalsTheme } from "./terminal.js";
import { initSessions, updateSessions, updateSessionMetrics, setSelectedSession, focusSidebar, clearCursor, siblingSession } from "./sessions.js";
import { renderUsage } from "./usage.js";
import { initProjectPicker, updateProjects } from "./projects.js";
import { initQuickTabs } from "./quicktabs.js";
import { initReports, setReports, showReport, setReportStatus } from "./reports.js";
import { fmtNum, shortModel } from "./fmt.js";
import { THEMES, THEME_ORDER, DEFAULT_THEME, STORAGE_KEY, type ThemeName } from "./themes.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const termWrap = document.getElementById("terminal-wrap") as HTMLElement;
const sessionListEl = document.getElementById("session-list") as HTMLElement;
const metricsStrip = document.getElementById("metrics-strip") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const newBtn = document.getElementById("new-session-btn") as HTMLButtonElement;
const newForm = document.getElementById("new-session-form") as HTMLElement;
const cwdInput = document.getElementById("cwd-input") as HTMLInputElement;
const pickerEl = document.getElementById("project-picker") as HTMLElement;
const projectTabsEl = document.getElementById("project-tabs") as HTMLElement;
const openBtn = document.getElementById("open-session-btn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel-session-btn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const toastContainer = document.getElementById("toast-container") as HTMLElement;
const themeSwitcherEl = document.getElementById("theme-switcher") as HTMLElement;

const mModel = document.getElementById("m-model") as HTMLElement;
const mContext = document.getElementById("m-context") as HTMLElement;
const mTokens = document.getElementById("m-tokens") as HTMLElement;
const mProgress = document.getElementById("m-progress") as HTMLElement;
const mTurns = document.getElementById("m-turns") as HTMLElement;

// ── Active session metrics ────────────────────────────────────────────────────
const latestMetrics = new Map<string, SessionMetrics>();

function showMetrics(m: SessionMetrics): void {
  const pct = m.contextPct != null ? `${Math.round(m.contextPct)}%` : "?%";
  const c = m.cumulative;
  mModel.textContent = shortModel(m.model);
  mContext.textContent = `ctx ${pct}`;
  mTokens.textContent = `↑${fmtNum(c.input)} ↓${fmtNum(c.output)} ♲${fmtNum(c.cacheRead)}`;
  mProgress.textContent = m.progress ?? (m.lastTool ? `${m.lastTool}` : "—");
  mTurns.textContent = `${m.turnCount} turns`;
}

// ── Session selection ─────────────────────────────────────────────────────────
function selectSession(id: string): void {
  const wasActive = getActiveId() === id;
  setSelectedSession(id);
  if (!wasActive) send({ t: "attach", id }); // re-attaching replays scrollback → skip if already shown
  activate(id);
  emptyState.style.display = "none";
  metricsStrip.classList.remove("hidden");
  const m = latestMetrics.get(id);
  if (m) showMetrics(m);
}

// Keyboard: Enter on a sidebar row — select it and drop focus into the terminal.
function enterSession(id: string): void {
  selectSession(id);
  clearCursor();
  focusTerminal();
}

// Global shortcut: Shift+Arrow hops straight to the previous/next session and
// dives into its terminal — no sidebar detour. ↑/← = previous, ↓/→ = next
// (the list is vertical, so both orientations map to the same move). Skip when
// another modifier is held or focus is in a plain text input (e.g. the new-
// session cwd field), so Shift+Arrow still selects text there.
document.addEventListener("keydown", (e) => {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.tagName === "INPUT") return; // xterm uses a <textarea>, so this only guards form inputs
  let delta = 0;
  if (e.key === "ArrowUp" || e.key === "ArrowLeft") delta = -1;
  else if (e.key === "ArrowDown" || e.key === "ArrowRight") delta = 1;
  else return;
  const id = siblingSession(delta);
  if (!id || id === getActiveId()) return; // already at the edge → nothing to do
  e.preventDefault();
  enterSession(id);
});

// When sessions disappear from the list (closed via ×), dispose their terminals;
// if the active session is the one that went away, reset the pane to empty.
function reconcileClosed(list: SessionMeta[]): void {
  const live = new Set(list.map((s) => s.id));
  for (const id of terminalIds()) {
    if (!live.has(id)) disposeTerminal(id); // clears activeId if it was active
  }
  if (!getActiveId()) {
    emptyState.style.display = "";
    metricsStrip.classList.add("hidden");
  }
}

// ── New session form ──────────────────────────────────────────────────────────
newBtn.addEventListener("click", () => {
  newForm.classList.toggle("hidden");
  if (!newForm.classList.contains("hidden")) {
    send({ t: "listProjects" }); // refresh recents in case sessions changed
    cwdInput.focus();
  }
});

cancelBtn.addEventListener("click", () => newForm.classList.add("hidden"));

function submitOpen(): void {
  const cwd = cwdInput.value.trim();
  if (!cwd) return;
  send({ t: "open", cwd });
  cwdInput.value = "";
  newForm.classList.add("hidden");
}

openBtn.addEventListener("click", submitOpen);
cwdInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitOpen();
  if (e.key === "Escape") newForm.classList.add("hidden");
});

// ── Usage refresh ─────────────────────────────────────────────────────────────
refreshBtn.addEventListener("click", () => send({ t: "refreshUsage" }));

// ── Theme switcher ───────────────────────────────────────────────────────────
// index.html's anti-flash script already stamped <html data-theme> from
// localStorage before this module ran, so that's the source of truth for
// "what's active" — this just keeps the switcher, localStorage, and open
// terminals in sync with it going forward.
function currentTheme(): ThemeName {
  const t = document.documentElement.dataset.theme as ThemeName | undefined;
  return t && THEMES[t] ? t : DEFAULT_THEME;
}

function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // private-mode / storage-disabled — theme still applies, just won't persist
  }
  setTerminalsTheme(name);
  renderThemeSwitcher();
}

function renderThemeSwitcher(): void {
  const active = currentTheme();
  themeSwitcherEl.innerHTML = "";
  for (const name of THEME_ORDER) {
    const def = THEMES[name];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-swatch";
    btn.title = def.label;
    btn.setAttribute("aria-pressed", String(name === active));
    btn.style.background = `linear-gradient(135deg, ${def.previewBg} 50%, ${def.previewAccent} 50%)`;
    btn.addEventListener("click", () => applyTheme(name));
    themeSwitcherEl.appendChild(btn);
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ── WS message dispatch ───────────────────────────────────────────────────────
onMessage((msg: ServerMsg) => {
  switch (msg.t) {
    case "hello":
      updateSessions(msg.sessions);
      renderUsage(msg.usage);
      updateProjects(msg.projects);
      reconcileClosed(msg.sessions);
      // On reconnect the server builds a fresh Client with an empty attached set,
      // so live pty frames stop arriving. Re-subscribe every terminal we still
      // show; the server replays scrollback, which the "scrollback" case resets
      // before writing (below) so there's no duplication.
      for (const id of terminalIds()) send({ t: "attach", id });
      break;

    case "sessions":
      updateSessions(msg.sessions);
      reconcileClosed(msg.sessions);
      break;

    case "opened":
      // A session THIS client just opened (typed path or Recent/Favorite click).
      // Select it immediately so the main pane shows it, as if the row was clicked.
      selectSession(msg.id);
      break;

    case "projects":
      updateProjects(msg.projects);
      break;

    case "scrollback":
      // Full-buffer replay on (re)attach — reset first so switching X→Y→X (or a
      // reconnect) doesn't append a duplicate copy of already-present content.
      resetTerminal(msg.id);
      write(msg.id, msg.data);
      break;

    case "pty":
      write(msg.id, msg.data);
      break;

    case "metrics": {
      const m = msg.metrics;
      latestMetrics.set(m.id, m);
      updateSessionMetrics(m);
      if (m.id === getActiveId()) showMetrics(m);
      break;
    }

    case "usage":
      renderUsage(msg.usage);
      break;

    case "exit":
      if (msg.id === getActiveId()) {
        mProgress.textContent = `exited (${msg.code})`;
      }
      break;

    case "reports":
      setReports(msg.dates);
      break;

    case "report":
      showReport(msg.date, msg.markdown);
      break;

    case "reportStatus":
      setReportStatus(msg.text, msg.busy);
      break;

    case "error":
      showToast(msg.message);
      break;
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
void (async () => {
  initTerminalContainer(termWrap, () => focusSidebar(), showToast);
  initSessions(sessionListEl, selectSession, enterSession);
  initProjectPicker(pickerEl, (path) => {
    send({ t: "open", cwd: path });
    newForm.classList.add("hidden");
  });
  // 상단 고정 프로젝트 탭 — 대표님 `cc` 셸 메뉴를 옮긴 것.
  // 탭 클릭 = 그 폴더에서 새 세션 열기 + (cc 처럼) "/start" 클립보드 복사.
  initQuickTabs(projectTabsEl, (p) => {
    send({ t: "open", cwd: p.path, title: `${p.emoji} ${p.label}` });
    navigator.clipboard?.writeText("/start").catch(() => {});
    showToast(`${p.emoji} ${p.label} 세션 여는 중 · 「/start」 복사됨 (⌘V + Enter)`);
  });
  initReports();
  renderThemeSwitcher();
  await connect();
})();
