import "@xterm/xterm/css/xterm.css";
import "../style.css";

import type { ServerMsg, SessionMetrics } from "../../shared/types";
import { connect, onMessage, send } from "./ws.js";
import { initTerminalContainer, write, activate, getActiveId } from "./terminal.js";
import { initSessions, updateSessions, updateSessionMetrics, setSelectedSession } from "./sessions.js";
import { renderUsage } from "./usage.js";
import { initProjectPicker, updateProjects } from "./projects.js";
import { fmtNum, shortModel } from "./fmt.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const termWrap = document.getElementById("terminal-wrap") as HTMLElement;
const sessionListEl = document.getElementById("session-list") as HTMLElement;
const metricsStrip = document.getElementById("metrics-strip") as HTMLElement;
const emptyState = document.getElementById("empty-state") as HTMLElement;
const newBtn = document.getElementById("new-session-btn") as HTMLButtonElement;
const newForm = document.getElementById("new-session-form") as HTMLElement;
const cwdInput = document.getElementById("cwd-input") as HTMLInputElement;
const pickerEl = document.getElementById("project-picker") as HTMLElement;
const openBtn = document.getElementById("open-session-btn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel-session-btn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const toastContainer = document.getElementById("toast-container") as HTMLElement;

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
  setSelectedSession(id);
  send({ t: "attach", id });
  activate(id);
  emptyState.style.display = "none";
  metricsStrip.classList.remove("hidden");
  const m = latestMetrics.get(id);
  if (m) showMetrics(m);
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
      break;

    case "sessions":
      updateSessions(msg.sessions);
      break;

    case "projects":
      updateProjects(msg.projects);
      break;

    case "scrollback":
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

    case "error":
      showToast(msg.message);
      break;
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
void (async () => {
  initTerminalContainer(termWrap);
  initSessions(sessionListEl, selectSession);
  initProjectPicker(pickerEl, (path) => {
    send({ t: "open", cwd: path });
    newForm.classList.add("hidden");
  });
  await connect();
})();
